// Proradius → Firebase usage robot.
// Logs into the Proradius reseller panel, reads every user's data usage, and
// writes it to Firebase Realtime Database under /usage/{username}. Triggered on
// a schedule (cron-job.org hits /sync every few minutes). The FlashNet app then
// reads /usage in real time and shows each client their quota.

import express from "express";
import admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
// undici's low-level request() + ProxyAgent: used ONLY for the second ISP (Terra),
// whose panel is geo-locked to Lebanon, so those calls must exit through a
// Lebanese proxy. Proradius keeps using Node's built-in global fetch (no proxy).
import { request, ProxyAgent } from "undici";

const {
  PRORADIUS_URL = "https://acp.novalb.net",
  PRORADIUS_USER,
  PRORADIUS_PASS,
  FIREBASE_DB_URL,
  FIREBASE_SERVICE_ACCOUNT, // the service-account JSON, pasted as one env var
  SYNC_SECRET,              // shared secret so only your cron can trigger /sync
  // ---- Third ISP: Sodetel — ANOTHER Proradius panel (same API as Nova). Not geo-locked,
  //      so it uses the same direct fetch as Nova (no proxy). Stays off until credentials are set. ----
  SODETEL_URL = "https://hsi.sodetel.net.lb",
  SODETEL_USER,             // Sodetel reseller login (set on Render, never in code)
  SODETEL_PASS,
  // ---- Second ISP: Terra (Terranet); all optional — Terra stays off until set ----
  TERRA_URL = "https://acppro.terra.net.lb",
  TERRA_USER,               // Terra panel login (set on Render, never in code)
  TERRA_PASS,
  TERRA_PROXY_URL,          // Lebanese proxy, e.g. http://user:pass@host:port
  TERRA_INTERVAL_MIN = "20",// how often to sync Terra (keeps proxy traffic low)
  ANTHROPIC_API_KEY,        // Claude API key for the in-app assistant (/ask). Set on Render, never in code.
  PORT = 10000,
} = process.env;

// ---- Firebase Admin (writes bypass security rules) ----
function loadServiceAccount() {
  const raw = FIREBASE_SERVICE_ACCOUNT || "";
  // Accept either raw JSON or base64-encoded JSON.
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}
let serviceAccount;
try {
  serviceAccount = loadServiceAccount();
  if (!serviceAccount.private_key) throw new Error("parsed, but no private_key field");
} catch (e) {
  console.error("✗ FIREBASE_SERVICE_ACCOUNT is missing or not valid JSON — re-copy the WHOLE value");
  console.error('  (it starts with {"type":"service_account") into the secret / env var.');
  console.error("  Details:", String(e.message || e));
  process.exit(1);
}
// Forgive common paste mistakes in the URL (surrounding quotes, stray whitespace).
const dbUrl = String(FIREBASE_DB_URL || "").trim().replace(/^["']+|["']+$/g, "");
if (!/^https:\/\/.+/.test(dbUrl)) {
  console.error("✗ FIREBASE_DB_URL is missing or not a valid URL — set it to exactly:");
  console.error("  https://flashnet-32686-default-rtdb.firebaseio.com  (no quotes, no spaces)");
  console.error("  Current value looks like:", JSON.stringify(FIREBASE_DB_URL || ""));
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: dbUrl,
});
const db = admin.database();

// ---- Proradius API (shared by every Proradius panel: Nova, Sodetel, …) ----
// Each panel is one config { url, user, pass, source }; the API shape is identical,
// so login + user-list are written once and reused for all of them.
async function proradiusLogin(cfg) {
  const r = await fetch(`${cfg.url}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  if (!r.ok) throw new Error(`${cfg.source} login failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.access) throw new Error(`${cfg.source} login: no access token in response`);
  return j.access;
}

async function fetchAllUsers(cfg, token) {
  const all = [];
  const pageSize = 100;
  let pageIndex = 1;
  // Loop pages until we've collected everyone (panel reports body.itemscount).
  for (let guard = 0; guard < 50; guard++) {
    const url =
      `${cfg.url}/api/users?pageIndex=${pageIndex}&pageSize=${pageSize}` +
      `&sortField=username&sortOrder=asc&usersFilter=my&status=0`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${cfg.source} users fetch failed: HTTP ${r.status}`);
    const j = await r.json();
    const data = j?.body?.data || [];
    const total = Number(j?.body?.itemscount ?? data.length);
    all.push(...data);
    if (data.length === 0 || all.length >= total) break;
    pageIndex++;
  }
  return all;
}

// "2.23GB/9.77GB" -> { used: 2.23, quota: 9.77 } (always in GB)
function parseTraff(s) {
  if (!s || typeof s !== "string") return { used: null, quota: null };
  const toGB = (part) => {
    if (!part) return null;
    const v = parseFloat(part.replace(",", "."));
    if (Number.isNaN(v)) return null;
    if (/tb/i.test(part)) return v * 1024;
    if (/mb/i.test(part)) return v / 1024;
    if (/kb/i.test(part)) return v / (1024 * 1024);
    return v; // GB (or bare number)
  };
  const [a, b] = s.split("/");
  return { used: toGB(a), quota: toGB(b) };
}

function round(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

// "Joined" date = expiry minus one month (all accounts were created this month),
// formatted YYYY-MM-DD. Computed once, then frozen (see sync()).
function joinedFromExpiry(expiry) {
  if (!expiry) return "";
  const d = new Date(String(expiry).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  d.setMonth(d.getMonth() - 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Flag brand-new panel users (added AFTER this feature was switched on) into
// ispNew/{username} so the manager can import them. On the very first run per
// source we only seed the "known" set (no flagging), so the existing backlog
// of un-imported clients isn't dumped on the manager all at once.
async function detectNewClients(source, rows) {
  const seededRef = db.ref(`ispSeeded/${source}`);
  const seeded = (await seededRef.once("value")).val();
  const known = (await db.ref("ispKnown").once("value")).val() || {};
  const knownUpd = {};
  const newUpd = {};
  const now = Date.now();
  for (const r of rows) {
    if (!r.username || known[r.username]) continue;
    knownUpd[r.username] = true;
    if (seeded) newUpd[r.username] = { ...r, source, at: now };
  }
  if (Object.keys(knownUpd).length) await db.ref("ispKnown").update(knownUpd);
  if (Object.keys(newUpd).length) await db.ref("ispNew").update(newUpd);
  if (!seeded) await seededRef.set(true);
}

// Append ONE daily usage sample per user → /usageHistory/{username}/{YYYY-MM-DD}.
// Re-runs on the same day overwrite that day's point (usage is cumulative, so the
// latest = the day's peak). Kept tiny (just used GB). This is what powers the
// portal's usage-trend graph and the monthly "Wrapped" recap.
async function writeUsageHistory(usageUpdates, now) {
  const day = new Date(now).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const hist = {};
  for (const [username, rec] of Object.entries(usageUpdates)) {
    if (rec && rec.usedGB != null) {
      hist[`${username}/${day}`] = { usedGB: rec.usedGB, quotaGB: rec.quotaGB ?? null, at: now };
    }
  }
  if (Object.keys(hist).length) {
    try { await db.ref("usageHistory").update(hist); }
    catch (e) { console.error("usageHistory write failed:", e?.message || e); }
  }
}

// One sync for a Proradius panel. Nova and Sodetel share this — only the config
// (URL + credentials) and the `source` tag differ. Usernames are unique per panel,
// so everyone is written into the same /usage/{username} node the app already reads.
async function proradiusSync(cfg) {
  if (!cfg.user || !cfg.pass) throw new Error(`${cfg.source} not configured (${cfg.source.toUpperCase()}_USER/${cfg.source.toUpperCase()}_PASS)`);
  const token = await proradiusLogin(cfg);
  const users = await fetchAllUsers(cfg, token);
  // Existing data so we can FREEZE the "joined" date once it's been set.
  const existing = (await db.ref("usage").once("value")).val() || {};
  const now = Date.now();
  const updates = {};
  for (const u of users) {
    const username = String(u.username || "").trim();
    if (!username) continue;
    const { used, quota } = parseTraff(u.used_traff);
    const percent =
      typeof u.percent === "number"
        ? u.percent
        : used != null && quota
        ? (used / quota) * 100
        : null;
    updates[username] = {
      username,
      name: u.shortname || "",
      service: u.servicename || "",
      usedGB: round(used),
      quotaGB: round(quota),
      remainingGB: used != null && quota != null ? round(Math.max(0, quota - used)) : null,
      usedText: u.used_traff || "",
      percent: percent == null ? null : Math.round(percent * 10) / 10,
      status: u.status || "",
      lastAct: u.last_act || "",
      expiry: u.expire_datetime || "",
      joined: existing[username]?.joined || joinedFromExpiry(u.expire_datetime),
      source: cfg.source,
      updatedAt: now,
    };
  }
  await db.ref("usage").update(updates);
  // Per-panel mirror: the SAME username can exist on two panels (Nova and Sodetel both use
  // Fn-style ids) and in flat /usage the later sync overwrites the earlier one. usageBySrc
  // keeps each panel's copy so the app can pick the record matching the client's supplier.
  await db.ref(`usageBySrc/${cfg.source}`).update(updates);
  await writeUsageHistory(updates, now);
  await detectNewClients(cfg.source, users.map((u) => ({
    username: String(u.username || "").trim(),
    name: u.shortname || "",
    service: u.servicename || "",
  })));
  return { count: Object.keys(updates).length, at: new Date(now).toISOString() };
}

// The Proradius panels we sync. Nova = daily allowance; Sodetel = another Proradius
// reseller panel (same API, different login). Both hit their API directly (no proxy).
const NOVA = { url: PRORADIUS_URL, user: PRORADIUS_USER, pass: PRORADIUS_PASS, source: "nova" };
const SODETEL = { url: SODETEL_URL, user: SODETEL_USER, pass: SODETEL_PASS, source: "sodetel" };
const sync = () => proradiusSync(NOVA);
const sodetelSync = () => proradiusSync(SODETEL);

// ============================================================================
// Second ISP: Terra (Terranet) — https://acppro.terra.net.lb
// The panel is geo-locked to Lebanon, so every request below exits through a
// Lebanese proxy (TERRA_PROXY_URL) via undici. Auth is a Django session: GET the
// login page for a CSRF token, POST the credentials, then reuse the sessionid
// cookie for the JSON user list. Usernames are unique across both ISPs, so Terra
// users are written into the SAME /usage/{username} node — the app needs no change.
// ============================================================================
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const randSession = () => Math.random().toString(36).slice(2, 10);

// Build an undici dispatcher that routes through the Lebanese proxy (if set). On IPRoyal the
// sticky-session id lives in the password (..._session-XXXX_lifetime-30m); we inject a FRESH
// session id on every call so each sync gets a new exit IP. That's the cure for the recurring
// 504s: a residential exit IP that dies is never reused across syncs (the old fixed session
// kept hammering the same dead IP for its whole 30-min lifetime). The id is constant WITHIN a
// single sync (same dispatcher for login + fetch), so the Django session stays valid.
function terraDispatcher() {
  if (!TERRA_PROXY_URL) return undefined; // no proxy → direct (won't reach Lebanon)
  const u = new URL(TERRA_PROXY_URL);
  const opts = { uri: `${u.protocol}//${u.host}` };
  if (u.username) {
    let pass = decodeURIComponent(u.password || "");
    pass = /_session-[^_]+/i.test(pass)
      ? pass.replace(/_session-[^_]+/i, `_session-${randSession()}`)
      : (pass ? `${pass}_session-${randSession()}` : pass);
    const auth = `${decodeURIComponent(u.username)}:${pass}`;
    opts.token = `Basic ${Buffer.from(auth).toString("base64")}`;
  }
  return new ProxyAgent(opts);
}

// Set-Cookie header (string or array) → { name: value }
function parseCookies(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const out = {};
  for (const line of list) {
    const [pair] = String(line).split(";");
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}
const cookieHeader = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join("; ");

async function terraLogin(dispatcher) {
  const loginUrl = `${TERRA_URL}/login/?next=/user/list/`;
  // 1) GET the login page → csrftoken cookie (+ hidden token if the form has one).
  const r1 = await request(loginUrl, { dispatcher, headers: { "user-agent": UA } });
  let cookies = parseCookies(r1.headers["set-cookie"]);
  const html = await r1.body.text();
  const m = html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i);
  const csrf = (m && m[1]) || cookies.csrftoken || "";
  // 2) POST the credentials. This panel's fields are login-username / login-password,
  //    submitted AJAX-style with the CSRF token in the X-CSRFToken header.
  const form = new URLSearchParams({
    "login-username": TERRA_USER || "",
    "login-password": TERRA_PASS || "",
  });
  if (m) form.set("csrfmiddlewaretoken", csrf);
  const r2 = await request(loginUrl, {
    method: "POST",
    dispatcher,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-csrftoken": csrf,
      "x-requested-with": "XMLHttpRequest",
      cookie: cookieHeader(cookies),
      referer: loginUrl,
      "user-agent": UA,
    },
    body: form.toString(),
  });
  cookies = { ...cookies, ...parseCookies(r2.headers["set-cookie"]) };
  await r2.body.dump();
  if (!cookies.sessionid) throw new Error(`Terra login failed (no sessionid; HTTP ${r2.statusCode})`);
  // 3) Load the user-list page once (like the browser) to confirm we're logged in
  //    and to hold the post-login csrftoken the JSON API expects.
  const r3 = await request(`${TERRA_URL}/user/list/`, {
    dispatcher,
    headers: { cookie: cookieHeader(cookies), referer: loginUrl, "user-agent": UA },
  });
  const status3 = r3.statusCode;
  cookies = { ...cookies, ...parseCookies(r3.headers["set-cookie"]) };
  await r3.body.dump();
  if (status3 >= 300 && status3 < 400) {
    throw new Error(`Terra login rejected — check TERRA_USER/TERRA_PASS (HTTP ${status3})`);
  }
  return cookies;
}

async function terraFetchAllUsers(cookies, dispatcher) {
  const all = [];
  const pageSize = 100;
  let pageIndex = 1;
  for (let guard = 0; guard < 50; guard++) {
    const url =
      `${TERRA_URL}/api/user/list/?username=&shortname=&address=&phone=` +
      `&resellername=&servicename=&fuplevel=&macaddr=&ip=&expire_datetime=` +
      `&price=&region=&building=&nationality=&status=0` +
      `&pageIndex=${pageIndex}&pageSize=${pageSize}`;
    const r = await request(url, {
      dispatcher,
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        "x-csrftoken": cookies.csrftoken || "",
        cookie: cookieHeader(cookies),
        referer: `${TERRA_URL}/user/list/`,
        "user-agent": UA,
      },
    });
    if (r.statusCode !== 200) {
      await r.body.dump();
      throw new Error(`Terra users fetch failed: HTTP ${r.statusCode}`);
    }
    const j = await r.body.json();
    const data = j?.data || [];
    const total = Number(j?.itemscount ?? data.length);
    all.push(...data);
    if (data.length === 0 || all.length >= total) break;
    pageIndex++;
  }
  return all;
}

async function terraSync(dispatcher = terraDispatcher()) {
  if (!TERRA_USER || !TERRA_PASS) throw new Error("Terra not configured (TERRA_USER/TERRA_PASS)");
  const cookies = await terraLogin(dispatcher);
  const users = await terraFetchAllUsers(cookies, dispatcher);
  const now = Date.now();
  const updates = {};
  for (const u of users) {
    const username = String(u.username || "").trim();
    if (!username) continue;
    const { used, quota } = parseTraff(u.used_traff);
    const percent =
      typeof u.percent === "number"
        ? u.percent
        : used != null && quota
        ? (used / quota) * 100
        : null;
    updates[username] = {
      username,
      name: u.shortname || "",
      service: u.servicename || "",
      usedGB: round(used),
      quotaGB: round(quota),
      remainingGB: used != null && quota != null ? round(Math.max(0, quota - used)) : null,
      usedText: u.used_traff || "",
      percent: percent == null ? null : Math.round(percent * 10) / 10,
      status: u.status || "",
      lastAct: u.last_act || "",
      expiry: u.expire_datetime || "",
      // Terra reports a real signup date, so "joined" is exact (no estimating).
      joined: String(u.created_datetime || "").split(" ")[0],
      source: "terra",
      updatedAt: now,
    };
  }
  await db.ref("usage").update(updates);
  await db.ref("usageBySrc/terra").update(updates); // per-panel mirror (see proradiusSync note)
  await writeUsageHistory(updates, now);
  await detectNewClients("terra", users.map((u) => ({
    username: String(u.username || "").trim(),
    name: u.shortname || "",
    phone: u.phone || "",
    region: u.region || "",
    building: u.building || "",
    note: u.note || "",
    service: u.servicename || "",
  })));
  return { count: Object.keys(updates).length, at: new Date(now).toISOString() };
}

// Residential proxies hand out the occasional dead exit IP (504). Each attempt uses a fresh
// dispatcher = a fresh proxy session = a different exit IP, so a couple of retries almost
// always lands on a working one.
async function terraSyncRetry(attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await terraSync(terraDispatcher());
    } catch (e) {
      lastErr = e;
      console.error(`[terra] attempt ${i}/${attempts} failed: ${String(e.message || e)}`);
    }
  }
  throw lastErr;
}

// ---- HTTP server (Render + cron trigger) ----
let last = { ok: null, count: 0, at: null, error: null };          // Proradius (Nova)
let lastSodetel = { ok: null, count: 0, at: null, error: null };   // Sodetel
let lastTerra = { ok: null, count: 0, at: null, error: null };     // Terra
let lastTerraAt = 0;
const TERRA_INTERVAL_MS = (Number(TERRA_INTERVAL_MIN) || 20) * 60 * 1000;
const terraEnabled = () => Boolean(TERRA_USER && TERRA_PASS);
const sodetelEnabled = () => Boolean(SODETEL_USER && SODETEL_PASS);

const app = express();
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "usage-robot", proradius: last, sodetel: lastSodetel, terra: lastTerra })
);

// Cron hits /sync every few minutes: Proradius runs every time; Terra is throttled
// to every TERRA_INTERVAL_MIN minutes to keep proxy traffic tiny. A failure in one
// ISP never blocks the other. Add ?terra=1 to force a Terra sync this call.
app.get("/sync", async (req, res) => {
  if (SYNC_SECRET && req.query.key !== SYNC_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const out = { ok: true };
  try {
    const r = await sync();
    last = { ok: true, ...r, error: null };
    out.proradius = r;
  } catch (e) {
    last = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
    out.proradius = { error: String(e.message || e) };
    console.error("[proradius]", e);
  }
  // Sodetel: another Proradius panel, direct fetch → run it every sync (like Nova).
  // A failure here never blocks Nova or Terra.
  if (sodetelEnabled()) {
    try {
      const r = await sodetelSync();
      lastSodetel = { ok: true, ...r, error: null };
      out.sodetel = r;
    } catch (e) {
      lastSodetel = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
      out.sodetel = { error: String(e.message || e) };
      console.error("[sodetel]", e);
    }
  }
  if (terraEnabled() && (req.query.terra === "1" || Date.now() - lastTerraAt >= TERRA_INTERVAL_MS)) {
    lastTerraAt = Date.now();
    try {
      const r = await terraSyncRetry();
      lastTerra = { ok: true, ...r, error: null };
      out.terra = r;
    } catch (e) {
      lastTerra = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
      out.terra = { error: String(e.message || e) };
      console.error("[terra]", e);
    }
  } else if (terraEnabled()) {
    out.terra = { skipped: "throttled" };
  }
  res.json(out);
});

// Force a Sodetel-only sync right now — handy for testing the login/credentials.
app.get("/sync-sodetel", async (req, res) => {
  if (SYNC_SECRET && req.query.key !== SYNC_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const r = await sodetelSync();
    lastSodetel = { ok: true, ...r, error: null };
    res.json({ ok: true, ...r });
  } catch (e) {
    lastSodetel = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
    console.error("[sodetel]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Force a Terra-only sync right now — handy for testing the proxy + login.
app.get("/sync-terra", async (req, res) => {
  if (SYNC_SECRET && req.query.key !== SYNC_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const r = await terraSyncRetry();
    lastTerra = { ok: true, ...r, error: null };
    lastTerraAt = Date.now();
    res.json({ ok: true, ...r });
  } catch (e) {
    lastTerra = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
    console.error("[terra]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ─────────────────────────── In-app AI assistant (/ask) ───────────────────────────
// The manager website calls POST /ask from the browser. Auth is by Firebase ID token
// (only real managers / collect-admins), so an open CORS origin is safe — a stranger
// has no valid token and can't spend the Claude budget. The API key lives only here.
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "authorization, content-type");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Only a signed-in manager (or collect-admin) may use the assistant.
async function requireManager(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) throw new Error("auth: missing token");
  const decoded = await admin.auth().verifyIdToken(m[1]);
  const [mgr, adm] = await Promise.all([
    db.ref(`managers/${decoded.uid}`).once("value"),
    db.ref(`collectAdmins/${decoded.uid}`).once("value"),
  ]);
  if (!mgr.exists() && !adm.exists()) throw new Error("auth: not a manager");
  return decoded;
}

// A COMPLETE, current snapshot of the whole business — everything the assistant may need
// to answer any question: every active client with their plan/price/region/supplier/
// payment method/expiry/usage, all bundles (price + cost), methods, regions, and finances.
async function buildContext() {
  const [clientsS, paymentsS, suppliersS, regionsS, methodsS, usageS, mikrotiksS, settingsS] = await Promise.all([
    db.ref("clients").once("value"),
    db.ref("payments").once("value"),
    db.ref("suppliers").once("value"),
    db.ref("regions").once("value"),
    db.ref("paymentMethods").once("value"),
    db.ref("usage").once("value"),
    db.ref("mikrotiks").once("value"),
    db.ref("appSettings").once("value"),
  ]);
  const clients = Object.values(clientsS.val() || {});
  const payments = Object.values(paymentsS.val() || {});
  const suppliers = Object.values(suppliersS.val() || {});
  const regions = Object.values(regionsS.val() || {});
  const methods = Object.values(methodsS.val() || {});
  const mikrotiks = Object.values(mikrotiksS.val() || {});
  const usage = usageS.val() || {};
  const settings = settingsS.val() || {};

  const now = new Date();
  const period = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).format(now).slice(0, 7); // YYYY-MM (Beirut)
  const round = (n) => Math.round(Number(n || 0) * 100) / 100;
  const regionName = (id) => regions.find((r) => r.id === id)?.name || "—";
  const methodName = (id) => methods.find((m) => m.id === id)?.name || "Unknown";
  const supplierName = (id) => suppliers.find((s) => s.id === id)?.name || "Unknown";
  const bundleOf = (c) => { const sup = suppliers.find((s) => s.id === c.supplierId); return sup?.bundles?.find((b) => b.id === c.bundleId) || null; };
  const bundleLabel = (b) => (b ? (b.displayName || b.name || b.speed || "—") : "—");
  const clientPrice = (c) => {
    const b = bundleOf(c);
    const isMk = !!c.mikrotikId && !!c.mikrotikPortId;
    const base = isMk ? Number(b?.sellingPrice ?? c.sellingPrice ?? 0) : Number(b?.sellingPrice ?? 0);
    let amt = Math.max(0, base - Number(c.discount || 0));
    if (c.hasSatellite) amt += Number(c.satellitePrice || 0);
    return round(amt);
  };
  const clientCost = (c) => round(bundleOf(c)?.cost || 0);
  const pickUsage = (c) => {
    for (const k of [c.user, c.mikrotikSecret]) {
      const key = (k || "").toString().trim();
      if (!key) continue;
      if (usage[key]) return usage[key];
      if (usage[`${key}@mdiab`]) return usage[`${key}@mdiab`];
    }
    return null;
  };

  const active = clients.filter((c) => (c.status || "active") === "active");
  const archived = clients.filter((c) => (c.status || "active") === "archived");
  const thisMonth = payments.filter((p) => p.period === period && p.approved !== false);
  const collected = thisMonth.reduce((s, p) => s + Number(p.amount || 0), 0);
  const paidIds = new Set(thisMonth.map((p) => p.clientId));

  const byRegion = {}, byPaymentMethod = {}, bySupplier = {};
  let revenue = 0, cost = 0;
  const clientList = active.map((c) => {
    const price = clientPrice(c); revenue += price; cost += clientCost(c);
    const rn = regionName(c.regionId), pm = methodName(c.paymentMethodId), sp = supplierName(c.supplierId);
    byRegion[rn] = byRegion[rn] || { active: 0, unpaidThisMonth: 0 };
    byRegion[rn].active++; if (!paidIds.has(c.id)) byRegion[rn].unpaidThisMonth++;
    byPaymentMethod[pm] = (byPaymentMethod[pm] || 0) + 1;
    bySupplier[sp] = (bySupplier[sp] || 0) + 1;
    const u = pickUsage(c);
    return {
      name: c.name || "—", region: rn, supplier: sp, plan: bundleLabel(bundleOf(c)),
      priceUSD: price, pay: pm, phone: c.phone || "",
      subscriptionEnds: c.subEnd || null, paidThisMonth: paidIds.has(c.id),
      ...(u ? { usedGB: u.usedGB ?? null, quotaGB: u.quotaGB ?? null, ispExpiry: u.expiry || null } : {}),
    };
  });

  return {
    today: now.toISOString(),
    currentMonth: period,
    timezone: "Asia/Beirut",
    business: {
      name: "FlashNet — Boussi Fiber Networks (fiber/internet ISP, Lebanon)",
      contactPhone: settings.contactPhone || "",
      monthlySurcharge: Number(settings.monthlySurcharge || 0),
      monthlySurchargeLabel: settings.monthlySurchargeLabel || "",
      note: "Nova = daily quota, free 12AM–12PM Beirut. Terra = monthly quota. Sodetel = a third provider (also a Proradius panel).",
    },
    bundlesBySupplier: suppliers.map((s) => ({
      supplier: s.name || "—",
      bundles: (s.bundles || []).map((b) => ({
        name: b.displayName || b.name || "—", speed: b.speed || "",
        priceUSD: round(b.sellingPrice), costUSD: b.cost != null ? round(b.cost) : null,
      })),
    })),
    paymentMethods: methods.map((m) => m.name).filter(Boolean),
    regions: regions.map((r) => r.name).filter(Boolean),
    mikrotiks: mikrotiks.map((m) => m.name).filter(Boolean),
    totals: { clients: clients.length, active: active.length, archived: archived.length },
    finance: {
      expectedMonthlyRevenueUSD: round(revenue),
      estimatedMonthlyCostUSD: round(cost),
      estimatedMonthlyProfitUSD: round(revenue - cost),
      collectedThisMonthUSD: round(collected),
      paymentsRecordedThisMonth: thisMonth.length,
      clientsPaidThisMonth: paidIds.size,
      clientsNotPaidThisMonth: active.filter((c) => !paidIds.has(c.id)).length,
    },
    byRegion, byPaymentMethod, bySupplier,
    clients: clientList,
  };
}

app.post("/ask", async (req, res) => {
  try {
    if (!anthropic) return res.status(503).json({ ok: false, error: "The assistant isn't configured yet — add ANTHROPIC_API_KEY on the server." });
    await requireManager(req);
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "empty question" });
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
    const ctx = await buildContext();
    const system = [
      "You are Flashy Bot — the professional AI assistant and business analyst for FlashNet, a fiber/internet ISP in Lebanon run by Boussi Fiber Networks. You work for the manager.",
      "You have a COMPLETE live snapshot of the business below. `clients` is the full list of every active client — each with their plan, monthly price (USD), payment method, region, supplier, subscription end date, whether they've paid this month, and their live data usage. You also have every bundle/plan (price + cost), all payment methods, regions, MikroTiks, and finance totals (revenue, cost, profit, collected).",
      "Answer any question by working directly with this data — count, filter, sum, sort, and compare it yourself. You genuinely know the whole business, so answer confidently and precisely; don't say you lack data unless a specific detail is truly absent.",
      "Rules: money is USD; dates/times are Beirut time. 'Unpaid/overdue' means paidThisMonth=false (mention subscriptionEnds if relevant). When listing clients, be tidy — name (+ phone/region/amount when useful); for long lists, give the count and the most relevant names, and offer the full list. You can draft WhatsApp messages in Arabic or English on request. Be professional, clear, and well-formatted (short headings/bullets when it helps). Give the answer first, detail after. Never invent numbers.",
      req.body?.lang === "ar"
        ? "IMPORTANT: Reply in Arabic (clear Levantine/Lebanese Arabic) unless the manager explicitly asks for English. Keep numbers, prices, dates, phone numbers, and client/plan names as-is."
        : "Reply in English unless the manager writes in Arabic or asks for Arabic.",
      "Complete business snapshot (JSON):",
      "```json",
      JSON.stringify(ctx),
      "```",
    ].join("\n");
    const messages = [
      ...history
        .filter((h) => h && (h.role === "user" || h.role === "assistant") && h.content)
        .map((h) => ({ role: h.role, content: String(h.content).slice(0, 4000) })),
      { role: "user", content: question.slice(0, 6000) },
    ];
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system,
      messages,
    });
    const answer = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ ok: true, answer: answer || "(no answer)" });
  } catch (e) {
    const msg = String(e?.message || e);
    const unauthorized = /^auth:/.test(msg) || /token/i.test(msg);
    console.error("[ask]", msg);
    res.status(unauthorized ? 401 : 500).json({
      ok: false,
      error: unauthorized ? "Not authorized — sign in as a manager." : "Assistant error: " + msg,
    });
  }
});

// ---- One-shot mode (GitHub Actions): `node index.js --once` runs ONE sync of every enabled
// ISP and exits — no HTTP server. Each run is a fresh process, so the Terra throttle can't
// live in memory here; it reads/writes ispMeta/lastTerraAt in the database instead (Admin SDK
// bypasses rules, and clients can't read ispMeta — same as ispKnown/ispSeeded).
async function runOnce() {
  const out = {};
  try { out.proradius = await sync(); } catch (e) { out.proradius = { error: String(e.message || e) }; console.error("[proradius]", e); }
  if (sodetelEnabled()) {
    try { out.sodetel = await sodetelSync(); } catch (e) { out.sodetel = { error: String(e.message || e) }; console.error("[sodetel]", e); }
  }
  if (terraEnabled()) {
    let lastAt = 0;
    try { lastAt = Number((await db.ref("ispMeta/lastTerraAt").once("value")).val() || 0); } catch { /* treat as never-synced */ }
    if (Date.now() - lastAt >= TERRA_INTERVAL_MS) {
      try {
        out.terra = await terraSyncRetry();
        await db.ref("ispMeta/lastTerraAt").set(Date.now());
      } catch (e) { out.terra = { error: String(e.message || e) }; console.error("[terra]", e); }
    } else {
      out.terra = { skipped: "throttled" };
    }
  }
  console.log("[once]", JSON.stringify(out));
  // Only fail the workflow when EVERY enabled ISP failed — a single flaky panel shouldn't go red.
  const results = Object.values(out);
  const allFailed = results.length > 0 && results.every((r) => r && r.error);
  process.exit(allFailed ? 1 : 0); // explicit exit — firebase-admin keeps handles open otherwise
}

if (process.argv.includes("--once")) {
  runOnce();
} else {
  app.listen(PORT, () => console.log("Usage robot listening on", PORT));
}

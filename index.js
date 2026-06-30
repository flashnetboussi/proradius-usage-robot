// Proradius → Firebase usage robot.
// Logs into the Proradius reseller panel, reads every user's data usage, and
// writes it to Firebase Realtime Database under /usage/{username}. Triggered on
// a schedule (cron-job.org hits /sync every few minutes). The FlashNet app then
// reads /usage in real time and shows each client their quota.

import express from "express";
import admin from "firebase-admin";
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
  // ---- Second ISP: Terra (Terranet); all optional — Terra stays off until set ----
  TERRA_URL = "https://acppro.terra.net.lb",
  TERRA_USER,               // Terra panel login (set on Render, never in code)
  TERRA_PASS,
  TERRA_PROXY_URL,          // Lebanese proxy, e.g. http://user:pass@host:port
  TERRA_INTERVAL_MIN = "20",// how often to sync Terra (keeps proxy traffic low)
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
admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
  databaseURL: FIREBASE_DB_URL,
});
const db = admin.database();

// ---- Proradius API ----
async function login() {
  const r = await fetch(`${PRORADIUS_URL}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PRORADIUS_USER, password: PRORADIUS_PASS }),
  });
  if (!r.ok) throw new Error(`Proradius login failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.access) throw new Error("Proradius login: no access token in response");
  return j.access;
}

async function fetchAllUsers(token) {
  const all = [];
  const pageSize = 100;
  let pageIndex = 1;
  // Loop pages until we've collected everyone (panel reports body.itemscount).
  for (let guard = 0; guard < 50; guard++) {
    const url =
      `${PRORADIUS_URL}/api/users?pageIndex=${pageIndex}&pageSize=${pageSize}` +
      `&sortField=username&sortOrder=asc&usersFilter=my&status=0`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Proradius users fetch failed: HTTP ${r.status}`);
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

async function sync() {
  const token = await login();
  const users = await fetchAllUsers(token);
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
      updatedAt: now,
    };
  }
  await db.ref("usage").update(updates);
  await detectNewClients("nova", users.map((u) => ({
    username: String(u.username || "").trim(),
    name: u.shortname || "",
    service: u.servicename || "",
  })));
  return { count: Object.keys(updates).length, at: new Date(now).toISOString() };
}

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

// Build an undici dispatcher that routes through the Lebanese proxy (if set).
function terraDispatcher() {
  if (!TERRA_PROXY_URL) return undefined; // no proxy → direct (won't reach Lebanon)
  const u = new URL(TERRA_PROXY_URL);
  const opts = { uri: `${u.protocol}//${u.host}` };
  if (u.username) {
    const auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
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

async function terraSync() {
  if (!TERRA_USER || !TERRA_PASS) throw new Error("Terra not configured (TERRA_USER/TERRA_PASS)");
  const dispatcher = terraDispatcher();
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

// ---- HTTP server (Render + cron trigger) ----
let last = { ok: null, count: 0, at: null, error: null };          // Proradius
let lastTerra = { ok: null, count: 0, at: null, error: null };     // Terra
let lastTerraAt = 0;
const TERRA_INTERVAL_MS = (Number(TERRA_INTERVAL_MIN) || 20) * 60 * 1000;
const terraEnabled = () => Boolean(TERRA_USER && TERRA_PASS);

const app = express();
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "usage-robot", proradius: last, terra: lastTerra })
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
  if (terraEnabled() && (req.query.terra === "1" || Date.now() - lastTerraAt >= TERRA_INTERVAL_MS)) {
    lastTerraAt = Date.now();
    try {
      const r = await terraSync();
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

// Force a Terra-only sync right now — handy for testing the proxy + login.
app.get("/sync-terra", async (req, res) => {
  if (SYNC_SECRET && req.query.key !== SYNC_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const r = await terraSync();
    lastTerra = { ok: true, ...r, error: null };
    lastTerraAt = Date.now();
    res.json({ ok: true, ...r });
  } catch (e) {
    lastTerra = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
    console.error("[terra]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Usage robot listening on", PORT));

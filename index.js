// Proradius → Firebase usage robot.
// Logs into the Proradius reseller panel, reads every user's data usage, and
// writes it to Firebase Realtime Database under /usage/{username}. Triggered on
// a schedule (cron-job.org hits /sync every few minutes). The FlashNet app then
// reads /usage in real time and shows each client their quota.

import express from "express";
import admin from "firebase-admin";

const {
  PRORADIUS_URL = "https://acp.novalb.net",
  PRORADIUS_USER,
  PRORADIUS_PASS,
  FIREBASE_DB_URL,
  FIREBASE_SERVICE_ACCOUNT, // the service-account JSON, pasted as one env var
  SYNC_SECRET,              // shared secret so only your cron can trigger /sync
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

async function sync() {
  const token = await login();
  const users = await fetchAllUsers(token);
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
      updatedAt: now,
    };
  }
  await db.ref("usage").update(updates);
  return { count: Object.keys(updates).length, at: new Date(now).toISOString() };
}

// ---- HTTP server (Render + cron trigger) ----
let last = { ok: null, count: 0, at: null, error: null };

const app = express();
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "proradius-usage-robot", last })
);
app.get("/sync", async (req, res) => {
  if (SYNC_SECRET && req.query.key !== SYNC_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const r = await sync();
    last = { ok: true, ...r, error: null };
    res.json({ ok: true, ...r });
  } catch (e) {
    last = { ok: false, count: 0, at: new Date().toISOString(), error: String(e.message || e) };
    console.error("[sync]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Proradius usage robot listening on", PORT));

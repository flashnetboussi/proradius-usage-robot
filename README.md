# Proradius → Firebase usage robot

Logs into the Proradius reseller panel, reads every user's data usage, and writes
it to Firebase Realtime Database under `/usage/{username}`. A cron service pings
`/sync` every few minutes; the FlashNet app reads `/usage` live and shows clients
their quota.

## Environment variables (set these on Render)

| Variable | Value |
|---|---|
| `PRORADIUS_URL` | `https://acp.novalb.net` |
| `PRORADIUS_USER` | your Proradius login (e.g. `j.flashnet`) |
| `PRORADIUS_PASS` | your **new** Proradius password |
| `FIREBASE_DB_URL` | e.g. `https://flashnet-32686-default-rtdb.firebaseio.com` |
| `FIREBASE_SERVICE_ACCOUNT` | the full service-account JSON (or its base64) |
| `SYNC_SECRET` | any random string — must match the `?key=` your cron uses |

## How it runs

- `GET /` → health + last sync result.
- `GET /sync?key=SYNC_SECRET` → does one sync (login → read users → write Firebase).
- Point **cron-job.org** at `https://<your-service>.onrender.com/sync?key=SYNC_SECRET`
  every ~5 minutes. That both runs the sync and keeps the free instance awake.

## Local test

```bash
npm install
# set the env vars (or use a .env loader), then:
npm start
# open http://localhost:10000/sync?key=...  (or whatever SYNC_SECRET you set)
```

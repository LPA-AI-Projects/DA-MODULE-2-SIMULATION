# Gulf Freight HR Dashboard — Simulation Platform

Role-based simulation platform with real-time trainer monitoring, live leaderboards, and batch analytics.

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3001** in your browser.

## Roles

### Student
1. Enter **Name** and optional **Email**
2. Click **Start** → waiting screen until trainer starts
3. Complete the simulation (unchanged question logic, scoring, timer flow)
4. View personal dashboard, live leaderboard, and learning report

### Trainer
- Access code: **2468**
- **Start Simulation** — releases all waiting students simultaneously
- **Reset Session** — clears all data; students must log in again
- Monitor live progress, final leaderboard, batch analytics
- **Trainer Reference** tab — full answer key and facilitation notes

## Architecture

- `server.js` — Express + Socket.io session management
- `sessionStore.js` — Redis-backed session persistence (in-memory fallback without `REDIS_URL`)
- `public/index.html` — Login, waiting, simulation, completion, trainer UI
- `public/js/simulation-engine.js` — Original simulation logic with session hooks
- `public/js/platform.js` — Real-time sync and dashboards
- `public/trainer-reference.html` — Trainer reference guide

## Environment Variables

Copy `.env.example` to `.env` for local development.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (Railway sets automatically) |
| `REDIS_URL` | Recommended | Redis connection URL for persistent sessions |
| `TRAINER_CODE` | No | Trainer login code (default: `2468`) |
| `CORS_ORIGIN` | No | Socket.io CORS origin (default: `*`) |

## Railway Deployment

1. Push this repo to GitHub
2. Create a Railway project → **Deploy from GitHub**
3. Add a **Redis** database in the same project
4. In your app service variables, set:
   - `REDIS_URL` = `${{Redis.REDIS_URL}}` (reference from Redis service)
   - `TRAINER_CODE` = your chosen code
5. Railway runs `npm start` automatically
6. Health check: `GET /health` → `{ ok: true, redis: true }`

Without `REDIS_URL`, the app still runs using in-memory storage (data lost on restart).

## Real-time Features

- Automatic waiting → simulation transition (no page refresh)
- Live participant monitoring on trainer dashboard
- Leaderboard updates as students finish
- Auto-generated batch analytics when all participants complete

## Rebuild Simulation Engine

If you modify `public/simulation-base.html`:

```bash
node build.js
```

## Notes

- Default port: **3001** (set `PORT` env var to override)
- Simulation scoring, questions, and progression are unchanged from the original HTML
- For multi-device testing, use the same server URL on all devices on your network

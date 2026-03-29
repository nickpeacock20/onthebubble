# On The Bubble — Playoff Tracker

Live NBA + NHL playoff tracker with Monte Carlo simulations.

## Repo Structure

```
onthebubble/
├── public/
│   └── index.html        ← Frontend (single file, no framework)
├── api/
│   ├── update.js         ← Fetches live NBA + NHL data, stores in KV
│   ├── montecarlo.js     ← 10,000-run simulation engine, stores odds in KV
│   └── data.js           ← Serves merged data to frontend
├── vercel.json           ← Cron schedule
└── package.json
```

## Setup

### 1. Push to GitHub

```bash
cd onthebubble
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/nickpeacock20/onthebubble.git
git push -u origin main
```

### 2. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → Sign up with GitHub
2. Click **Add New Project** → Import `nickpeacock20/onthebubble`
3. Leave all settings default → **Deploy**

### 3. Add Vercel KV (required for data storage)

1. In your Vercel project → **Storage** tab → **Create Database** → **KV**
2. Name it `onthebubble-kv` → Create
3. Vercel auto-injects `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` env vars

### 4. Trigger first data load

After deploy, hit these URLs once to populate the KV:

```
https://your-project.vercel.app/api/update
https://your-project.vercel.app/api/montecarlo
```

Then visit the site — it'll be live.

## Update Schedule

Defined in `vercel.json`:

| Cron | When | What |
|------|------|------|
| `*/5 23,0,1,2,3,4,5,6 * * *` | Every 5 min, 6pm–1:30am ET weekdays | Live standings + scores |
| `*/5 22,23,0,1,2,3,4,5,6 * * 6,0` | Every 5 min, 3pm–1:30am ET weekends | Live standings + scores |
| `0 7 * * *` | 2am ET nightly | Full Monte Carlo (10,000 runs) |

## How It Works

### Data Flow

```
NBA APIs ─────┐
NHL APIs ─────┼──► /api/update ──► Vercel KV (live_data)
              │
              └──► /api/montecarlo ──► Vercel KV (mc_odds)
                        │
                        ▼
              /api/data (serves both)
                        │
                        ▼
              index.html (fetches on load)
```

### Monte Carlo Model

**NBA:**
- Win prob = sigmoid((homeANR - awayANR + home_court_adj) / 7)
- ANR = season_netrtg × 0.70 + L15_netrtg × 0.30
- Net ratings derived from game log (pts scored/allowed per game)
- Home court: +2.5 pts standard, +3.0 if opponent on back-to-back
- H2H adjustment: up to 25% weight based on sample size
- 10,000 sims → final standings → apply play-in bracket → tally odds

**NHL:**
- Win prob = sigmoid((homeAGD - awayAGD + 0.15) / 2.5)
- AGD = season_GD_rate × 0.70 + L10_GD_rate × 0.30
- GD rate from standings API (goalFor/goalAgainst per game)
- 23% OT rate — both teams get 1pt, extra pt decided by same win prob
- 10,000 sims → top 3 per division + 2 wild cards = playoff picture

### Fallback

If `/api/data` is unavailable, the frontend renders from hardcoded data in `index.html`. Odds fall back to formula-based estimates. Site never goes blank.

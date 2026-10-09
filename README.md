# MSA Fantasy Football

Vercel-hosted fantasy league: static frontend (`public/`) + one serverless API (`api/index.js`) + Neon Postgres.
The 16 players from the spreadsheet are hard-coded in `api/index.js` (`RAW`) and copied into every new league. The owner can add players and change prices in the Admin tab.

## Deploy
1. Push this folder to a GitHub repo.
2. Vercel → Add New Project → import the repo (no build settings needed).
3. Project → Storage → add **Neon Postgres** (Marketplace). It sets `DATABASE_URL` automatically.
4. Redeploy. Tables are created automatically on the first request.
5. Open the site, **Start your own league** (you become the owner), then use **Invite on WhatsApp** on the Leaderboard tab.

## Local
```
npm i -g vercel && npm i
vercel link && vercel env pull .env.local
vercel dev
```

## How it works
- Friends join through the invite link (`/?join=CODE`) with a name + PIN. Same name + PIN signs in on another device.
- Round flow (Admin): squads open → add match stats → **Lock squads** → **Start round N+1** (everyone's squad is copied forward and reopened).
- Total = squad points + captain bonus - transfer penalty. 1 free transfer per round, then -4 each. Others' picks are hidden until squads lock.
- Budget, positions, lock state and owner-only actions are all checked on the server.

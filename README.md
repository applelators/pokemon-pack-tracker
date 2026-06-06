# Pokémon Pack Tracker

A personal web app for casual collectors to track Pokémon TCG product purchases per
expansion set, see how much you've spent, and estimate how many **more booster packs** you'd
need to open to complete the set's base (numbered) checklist.

**Live:** https://packs.nabunan.com (also https://pokemon-pack-tracker.applelators.workers.dev)

## Features
- Track purchases grouped by date — one order can hold multiple product types
  (booster pack, booster bundle, Elite Trainer Box, mini tin, regular tin).
- Per-product prices + a configurable local sales-tax rate; live subtotal / tax / total.
- Set data (name, base-set size, per-card rarity) pulled from **pokemontcg.io**.
- Rarity-weighted **Monte Carlo** estimate of packs needed to complete the base set, with
  median (p50) / unlucky (p90) outcomes and a "cards collected so far" progress estimate.

## Architecture
Hosted on Cloudflare, same pattern as `hgss-progress-tracker`:
- **Cloudflare Worker** (`_worker.js`) serves the JSON API under `/api/*` and falls through to
  the static frontend in `public/` via the `ASSETS` binding.
- **Cloudflare D1** (SQLite) stores settings, imported sets + rarities, and orders.
- Frontend is vanilla HTML/CSS/JS — no build step.

```
_worker.js          Worker entry: routes /api/* then falls back to static assets
wrangler.toml       Worker + assets + D1 bindings
schema.sql          D1 schema + default settings
src/
  api.js            request router + handlers
  store.js          D1 data access (settings, sets, orders, totals)
  pokemontcg.js     pokemontcg.io client (caches into D1)
  estimator.js      Monte Carlo completion simulation (pure JS)
public/             index.html, app.js, styles.css
```

## Local development
```bash
npm install
npm run db:local     # apply schema.sql to the local D1 (first time only)
npm run dev          # wrangler dev — http://localhost:8787
```
`wrangler dev` runs the Worker locally with an emulated D1, no Cloudflare account needed.

## Deploy
```bash
npm run db:create    # one-time: create the D1 database, paste its id into wrangler.toml
npm run db:remote    # apply schema.sql to the remote D1
npm run deploy       # wrangler deploy
```
The D1 database id is already wired into `wrangler.toml`. After deploy the Worker is served at
`https://pokemon-pack-tracker.<account>.workers.dev` (point a custom subdomain at it from the
Cloudflare dashboard if desired).

## Continuous deployment
Connected to **Cloudflare Workers Builds** — every push to `main` on
`applelators/pokemon-pack-tracker` automatically builds and deploys to packs.nabunan.com.
Build config: production branch `main`, deploy command `npx wrangler deploy`, no build step.
No API tokens are stored in GitHub; Workers Builds runs in the Cloudflare account context.

## How the estimate works
The base set is treated as a pool of distinct cards grouped by rarity. A 2026 booster is modeled
as 10 cards: 4 commons, 3 uncommons, 2 reverse holos, and 1 "hit" (Rare or better); the hit
slot's probability is split across the higher rarities. The app simulates opening packs until
every base-set card is collected, thousands of times, and averages the result. **Pull rates are
editable** in Settings → *Pull-rate model*. Any base-set rarity you don't explicitly list is
folded into the hit slot automatically, so completion is always possible.

This is a statistical estimate and assumes the packs you buy are packs you open. Completing a set
including its rarest cards realistically takes thousands of packs — the number is illustrative.

## Settings → pokemontcg.io API key
Works without a key at low volume. If you hit rate limits, get a free key at
https://dev.pokemontcg.io and paste it into Settings.

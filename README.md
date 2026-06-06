# Pokémon Pack Tracker

A personal web app for casual collectors to track Pokémon TCG product purchases per
expansion set, see how much you've spent, and estimate how many **more booster packs** you'd
need to open to complete the set's base (numbered) checklist.

## Features
- Track purchases grouped by date — one order can hold multiple product types
  (booster pack, booster bundle, Elite Trainer Box, mini tin, regular tin).
- Per-product prices + a configurable local sales-tax rate; live subtotal / tax / total.
- Set data (name, base-set size, per-card rarity) pulled from **pokemontcg.io**.
- Rarity-weighted **Monte Carlo** estimate of packs needed to complete the base set, with
  median (p50) / unlucky (p90) outcomes and a "cards collected so far" progress estimate.
- All data stored locally in SQLite — persists across restarts.

## Run
```bash
npm install
npm start          # serves http://localhost:3000  (set PORT to change)
```
Then open the URL, click **Add / import a set**, search (e.g. "Surging Sparks"), and import it.
Set your sales-tax rate in **Settings**, then add orders.

## How the estimate works
The base set is treated as a pool of distinct cards grouped by rarity. A booster is modeled as
a list of slots matching a real 2026 booster — 10 cards: 4 commons, 3 uncommons, 2
reverse-holos, 1 "hit" (Rare or better); the hit slot's probability
is split across the higher rarities. The app simulates opening packs until every base-set card
is collected, thousands of times, and averages the result. **Pull rates are editable** in
Settings → *Pull-rate model*. Any base-set rarity you don't explicitly list is folded into the
hit slot automatically, so completion is always possible.

Note: this is a statistical estimate and assumes the packs you buy are packs you open.
Completing a set including its rarest cards realistically takes thousands of packs — the number
is meant to be illustrative, not a shopping target.

## Settings → pokemontcg.io API key
Works without a key at low volume. If you hit rate limits, get a free key at
https://dev.pokemontcg.io and paste it into Settings.

## Tech
Node.js + Express, better-sqlite3, vanilla HTML/CSS/JS (no build step).

## Project layout
```
server/
  index.js              Express app + static serving
  db.js                 SQLite schema, defaults, settings helpers
  routes/               sets, orders, settings, estimate(+summary)
  services/
    pokemontcg.js       API client + caching
    estimator.js        Monte Carlo completion simulation
public/                 index.html, app.js, styles.css
data/tracker.db         SQLite database (gitignored)
```

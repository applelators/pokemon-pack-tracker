# Pokémon Pack Tracker — project & design guide

This file is read automatically by Claude Code. It documents the **visual language**
introduced in the dashboard redesign so future features stay consistent. Read this
before adding UI.

## Architecture (unchanged)
- Cloudflare Worker (`_worker.js`) + D1 database. Routes handled in `src/api.js`.
- Data access in `src/store.js`; pokemontcg.io client in `src/pokemontcg.js`;
  Monte-Carlo math in `src/estimator.js`. Schema in `schema.sql`.
- Frontend is **vanilla JS, no build step**: `public/index.html`, `public/app.js`,
  `public/styles.css`. Helpers: `$`/`$$` (querySelector), `api(path, opts)`, `toast()`.
- Do not introduce a framework or bundler. Keep the no-build, single-stylesheet setup.

## Design language

### Color — use the CSS variables in `:root`, never raw hex
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0f1420` | app background |
| `--panel` | `#1a2233` | card surfaces |
| `--panel-2` | `#232d42` | nested surfaces, chips, inputs-on-card |
| `--border` | `#2e3a52` | all 1px borders / dividers |
| `--text` | `#e8edf6` | primary text |
| `--muted` | `#94a3b8` | labels, secondary text |
| `--accent` | `#ffcb05` | **Pokémon yellow — the hero accent.** Reserve for the single most important number/action per view. |
| `--accent-2` | `#3b6fe0` | blue — secondary/interactive (links, focus, bar starts) |
| `--good` | `#34d399` | green — positive/progress (gauge + bar ends, the `+` in returns) |
| `--danger` | `#f87171` | destructive (delete) |

If you genuinely need a new hue, derive it in `oklch()` from these — don't invent fresh hex.

### Type — two families, loaded in `index.html`
- **Hanken Grotesk** — body text, labels, descriptions. Default on `body`.
- **Space Grotesk** — *display*: big numbers, headings, stat values, order dates,
  anything that should read as "data". Apply via `font-family: "Space Grotesk", sans-serif`.
- Headings `h2`/`h3` are already Space Grotesk globally. No other font families.
- Slide/print minimums don't apply (this is an app), but keep stat numbers large and labels small+uppercase.

### Core components / patterns (reuse these — don't reinvent)
- **Cards:** `background: var(--panel); border: 1px solid var(--border); border-radius: 14–18px;`
  padding ~18–30px. Group every content block into a card.
- **Section headers:** `.dash-h` on the dashboard; `.page-h` (with a yellow accent tick) for
  Orders/Settings page titles. Optional `.dash-hint` for a muted inline subtitle.
- **Stat chips:** uppercase muted micro-label + Space Grotesk value (see `.dh-chip`,
  `.order-totals span`). Use for compact KPI groups.
- **Completion gauge:** SVG ring with `#gaugeGrad` (yellow→green). Driven by `setGauge()`.
- **Progress bars:** `.bar > i`, gradient `--accent-2`→`--good`.
- **Chase slots:** `.slot` cards with per-rarity tints (`.ir/.ur/.sir/.mhr`) and `.off`
  for rarities not in the set. Built in `renderChase()`.
- **Set switcher:** header chip `.set-trigger` + dropdown `.set-menu` (`setupSetSwitcher()`).
  This is the canonical way to pick/add a set — don't add a second set picker.
- **Collection (binder) toggle:** segmented `.collection-toggle` / `.ct-btn` (active = `--accent-2`).
  Global one in the header (`Mine | Shared`, `setupCollectionToggle()` / `selectCollection()`,
  persisted in `localStorage` as `currentCollection`); a `.sm` variant on the order form picks the
  order's binder. Use this component for any binder switching — don't reinvent it.

### Rarity symbols — ALWAYS go through the helper
Rarity is shown as **stars/diamonds/circles whose COLOR encodes the tier**, matching the
printed Scarlet & Violet cards. Never hand-pick a rarity color.
- `raritySymbol(rarityString)` → returns the styled glyph(s). Backed by `RARITY_SYMBOL`
  (glyph + count + tier class) and `secretAbbr()` / `RARITY_ABBR` for short tags.
- Tiers: `r-black` (neutral grey on dark), `r-silver`, `r-gold`, `r-mhr` (etched gold gradient), `r-ace` (red).
  e.g. Illustration Rare = 1 gold ★, Ultra Rare = 2 silver ★★, Double Rare = 2 neutral ★★.
- New rarity? Add one entry to `RARITY_SYMBOL` (+ `RARITY_ABBR` if it needs a short tag).

### Count entry — reuse the stepper
For logging integer counts (e.g. secret cards pulled), use `secretStepMarkup(rarity, count, attrs)`
which renders an `.os-step` pill with −/+ buttons. Saved-order edits persist via a debounced
`PUT /api/orders/:id { finds }` (see `queueFindsSave`); form entry collects via `readFinds()`.
Don't drop in bare number inputs for counts. Each pill's `.os-odds` shows the expected quantity
of that rarity for the order's packs plus a live "chance of another" — `setStepOdds()` recomputes
`P(another) = 1 − (1−p)^(packs − found)` on every +/−.

### Layout & interaction conventions
- Lay out groups with **flex/grid + `gap`**, not margins or inline-block.
- Mobile: everything stacks at `max-width: 640px`; keep touch targets ≥ 38px.
- Buttons: default = yellow primary (reserve for the main action); `.ghost` = secondary.
- Persist any view/playback state to `localStorage` (already done for `currentSetId`).

## Data contract notes
- `GET /api/sets` returns rows incl. `logo_url` / `symbol_url` (added in the redesign).
  `saveSet` only writes these on **import**, so re-import a set to backfill art.
- `GET /api/sets/:id/summary` → `{ set, totalSpent, totalPacks, orderCount, breakdown,
  completion, chase }`. The redesign changed *where* these render, not the field names.
- **Collections:** every order carries `collection` = `'mine' | 'shared'` (separate physical
  binders). `GET /api/orders`, `/sets/:id/summary`, and `/estimate/:id` all accept `?collection=`,
  and the frontend always sends the active one — so all order-derived stats (spend, packs,
  completion, chase calibration, secret finds) are scoped per binder. Migration:
  `ALTER TABLE orders ADD COLUMN collection TEXT NOT NULL DEFAULT 'mine';`
- **Store + discount:** orders carry `store` (preset: "Offcourt TCG" / "Target" / "Other") and
  `discount_rate` (snapshot). `computeOrder` applies the discount to the subtotal and taxes the
  **discounted** amount: `total = (subtotal − subtotal·discount_rate)·(1 + tax_rate)`. Target with
  the Circle Card = `discount_rate 0.05`. Migration: `ALTER TABLE orders ADD COLUMN store TEXT;`
  and `ALTER TABLE orders ADD COLUMN discount_rate REAL NOT NULL DEFAULT 0;`
- **Progress actuals:** `progress(set_id, collection, packs_opened, cards_collected)` lets the user
  override model assumptions. Summary returns `packsBought`, `packsOpened` (= `packs_opened` ??
  bought), and `progress`. The estimator takes `collected`: it maps that card count to an
  equivalent pack position on the simulated curve and reports `actualPct`, `cardsRemaining`,
  `equivalentPacks`, `packsRemainingFromCards`. The dashboard "Your collection" card edits these
  (`PUT /api/sets/:id/progress?collection=`, debounced, then reload). New table — created by
  `schema.sql` (`CREATE TABLE IF NOT EXISTS progress ...`).
- Migration: existing databases need
  `ALTER TABLE sets ADD COLUMN logo_url TEXT;` and `... symbol_url TEXT;`.

## When adding a feature
1. Build it from the variables, two fonts, and the components above.
2. Match the card + section-header rhythm; keep one hero accent per view.
3. Route rarity through `raritySymbol()`, counts through `secretStepMarkup()`.
4. No new fonts, no new top-level colors, no build step.

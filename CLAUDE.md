# Pokémon Pack Tracker — project &amp; design guide

This file is read automatically by Claude Code. It documents the **redesign** that
replaced the original dashboard. Read this before adding UI so future work stays in
the new visual + interaction language.

> **Reference prototype:** `Pack Tracker.html` (+ `Pack Tracker — iPhone.html`) is the
> source of truth for the redesign — a single self-contained, no-build, vanilla-JS file
> (matching this repo's no-bundler philosophy). Everything below is implemented there;
> port patterns from it rather than reinventing. The prototype uses mock data; wire the
> same UI to the real Worker/D1 API.

---

## Architecture (unchanged)
- Cloudflare Worker (`_worker.js`) + D1. Routes in `src/api.js`; data access in
  `src/store.js`; pokemontcg.io client in `src/pokemontcg.js`; Monte-Carlo math in
  `src/estimator.js`. Schema in `schema.sql`.
- Frontend is **vanilla JS, no build step**: `public/index.html`, `public/app.js`,
  `public/styles.css`. Helpers `$`/`$$`, `api(path,opts)`, `toast()`.
- Do not introduce a framework or bundler.

### Data-model changes the redesign assumes
- **Orders are multi-set.** One order (one receipt) can contain line items from
  **different expansions**. Move `set_id` off `orders` and onto `order_items`
  (`order_items.set_id`). An order's "sets" = the distinct set_ids across its lines.
  `computeOrder` derives subtotal/packs/sets/total from the lines.
- **Live set stats.** Spent / packs / order-count per set are **derived from orders**
  (filtered by binder), never stored as static columns. Discounts + tax are applied
  per order when summing spend. Adding/editing/deleting an order updates every stat,
  the diminishing-returns figure, and the completion estimate immediately.
- **Diminishing returns counts from packs _bought_**, not opened (you can buy packs and
  open a subset). "N more packs on top of the X you own."
- **Cheapest-rip floor:** the cheapest-rip / "price to beat" value is never shown below
  **$5.00** (`marketOf(set) = max(5, market)`); it drives verdict thresholds too.
- **Secret-card pulls live on the order, edited separately** from the order itself
  (see Pulls modal). `order_finds` (rarity→count) + `order_pull_cards` unchanged.
- **Collection actuals** override the model: `progress(set_id, collection, cards_collected)`.
  Blank = model estimate; entered = real count.

---

## Design language (redesign)

### Color — CSS variables in `:root` (dark, slightly warmer than the old theme)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0e16` | app background (under a `radial-gradient` toward `#141b2b` at top) |
| `--panel` | `#151b29` | card surfaces |
| `--panel2` | `#0f1422` | nested/inset surfaces, inputs |
| `--panel3` | `#161d2c` | chips, secondary buttons |
| `--border` / `--border2` / `--line` | `#2b3346` / `#2e3650` / `#232b3e` | borders / hero border / dividers |
| `--text` `--soft` `--muted2` `--muted` | `#eef1f8` `#aeb7ca` `#9aa4ba` `#7d889e` | text ramp (primary→faint) |
| `--accent` | `#ffcb05` | Pokémon yellow — the single hero accent / primary buttons (`--accent-ink #1a1300` for text on it) |
| `--blue` | `#4a82f0` | progress-bar start, links |
| `--good` `--fair` `--bad` | `#2fd58a` `#ffb020` `#f76b6b` | **BUY / FAIR / PASS** verdicts, deal flags, deltas |

Derive any new hue in `oklch()` from these — don't invent fresh hex.

### Type — two families
- **Hanken Grotesk** — body, labels, descriptions (default on `body`).
- **Space Grotesk** — *display* (`.disp`): every number, heading, stat value, price,
  verdict word, set code. Big numbers read as "data."
- Micro-labels are uppercase, letter-spaced, `--muted` (`.uplabel`, `.eyebrow`).

### Core components (reuse — don't reinvent)
- **Cards:** `var(--panel)` + `1px var(--border)` + radius 14–20px, pad 16–22px.
- **Sheets (modals):** bottom-sheet pattern — `.scrim` (blur backdrop) > `.sheet`
  (max-width 740, slides up). Sticky `.sheet-head` and a sticky `.totbar` footer with
  primary `.save` + `.cancel`. Used by the order composer, manage-sets, and pulls.
  A centered `.confirm-card` variant (`.scrim.center`) is the destructive-confirm dialog.
- **Segmented control** `.seg` (+ `.seg.sq`); active button = yellow.
- **Set-number tile:** every set is shown by its **number** (`SV08`, `SV8.5`, `SV09`…),
  never an ad-hoc abbreviation, on a tinted striped gradient chip (`s.tint → #10182a`).
  Special sets get a holographic gradient ring (`.sp::before`, mask trick) + a `✦ Special`
  chip. Sets &gt;~24 months past release get a muted **"likely out of print"** badge.
- **Deal verdict:** `verdict(perPack,set)` → `{word:BUY|FAIR|PASS, color, bg, border, tone}`.
  good = `≤ ceiling`; bad = `≥ cheapestRip·1.25`; else fair.
- **Toast:** transient bottom-center; `toast(msg)`.

### Animation
- Quick and subtle. Hub rows fade-up (`@keyframes rowIn`, .34s, ~55ms stagger) **once per
  hub entry** (guarded by `state.hubAnimated`, reset only in `goHub`) — never re-fire on
  in-place updates like stepper clicks. Sheets use `sheetUp`; verdict uses `popIn`.

---

## Information architecture

The app is **hub-first**. `state.view` ∈ `hub | set`.

1. **Hub ("Your sets")** — landing page on every load. Art-forward list rows
   (1-across), **newest release first**. Each row: set art tile, name + series/release,
   live **completion % · packs-to-DR · spent · orders**, a **quick deal-check**
   (BUY/FAIR/PASS verdict + ± price stepper, no need to open the set), loose rip +
   last-refreshed (with stale "refresh" hint), and actions **Open dashboard / + Order /
   ↻ Refresh**. A prominent **+ Import a set** card opens the manage-sets sheet.
2. **Set view** — the dashboard for one set. Header has a `← All sets` backchip (and the
   logo) to return to the hub. Sections top→bottom:
   - **Set switcher** pills (tracked sets; switching resets the deal price).
   - **"Should I grab it?"** hero — the star. Loose-pack / booster-bundle tabs; big ±$1
     /±$5 price stepper; live verdict + "buy ~N" recommendation; and the **deal scale**
     (see below). Resets to the set's market price on switch — never carries the last
     set's price over.
   - **Diminishing returns** + a 4-up live stat strip.
   - **Desk detail** (see density rules): completion gauge + editable actuals,
     completion **estimate**, chase odds, product breakdown, rarity counts, expansion art.
   - **Recent orders** list.

### The three layout directions (A / B / C)
A small floating **Layout A/B/C** switcher (bottom-left; hidden in kiosk/`?layout=` mode)
toggles `state.direction`. **C ("Gallery") is the chosen direction** — art banner + full
detail on desktop. A = "Deal Desk" (scan-fast, no desk detail). B = "Field / Desk"
density toggle. The switcher is a prototype comparison aid; production can ship C.

### Density (responsive)
- **Desktop / Direction C:** full **Desk** detail (estimate, chase, breakdown, rarity, art).
- **Mobile (`≤640px`):** Direction C drops to **Field** density automatically — banner +
  deal check + diminishing returns + stats + orders; the heavy detail collapses.
  `showDesk = isC ? !mobile : (isB && mode==='desk')`.
- `Pack Tracker — iPhone.html` frames the app at iPhone 17 Pro size to preview this;
  it passes `?layout=C` (token-inherited) and the app adds top safe-area padding in
  kiosk mode.

---

## Key feature mechanics

- **Deal scale** (replaces the old four-number reference row). A green→amber→red price
  bar with a labeled pointer at the current per-pack price, three plain-language zone
  labels (**Good deal ≤ $X · Fair · Overpriced ≥ $W**), and one caption explaining
  cheapest-rip ("the price to beat") and pack value ("cards inside, on average"). Meaning
  comes from where the pointer lands — prefer this over cryptic stat chips.
- **Quick deal-check on hub** mirrors the hero verdict per set without navigating in.
- **Completion estimate** — headline is the **"to 95%"** packs number ("the realistic
  finish line"), with to-50% / to-100% (typical) / unlucky in the detail row.
- **Editable actuals** — "Your real card count" field overrides the estimate; blank keeps
  the default (shown as placeholder). When set, surface the **delta vs the estimate**
  (`+N` green if above, `−N` amber if below).
- **Order composer** (sheet) — one receipt, **each line picks its own set**; quick-add
  product chips; **store presets** (Offcourt TCG / Target / Too Many Games / Other) with
  **Target Circle −5%** toggle (discount applied before tax); live running total. Used for
  create **and** edit. Editing is a *before-opening* action — it does **not** include pull
  tagging.
- **Pulls modal** (🃏 button on each order row, beside edit/delete) — an *after-opening*
  action. Per-rarity steppers (IR/UR/SIR/MHR) with live Binomial odds ("≈E expected ·
  P% for one more") based on the order's pack count, plus a "tag the exact cards" grid.
  Saves `finds` + `tagged` to that order; rows with pulls show a `🃏 N pulls` chip.
- **Manage sets** sheet (from "+ Add set") — all expansions, **newest first**, each with
  loose rip · packs bought X/Y · packs-to-DR, special/out-of-print badges, and
  **Import / Reimport (refresh art &amp; prices) / Remove**. **Removal is blocked** when a
  set has any orders or owned packs, and only ever untracks (never deletes data).
- **Binder (Mine/Shared)** — **hidden by default**; the header switch only appears when
  **Settings → General → "Show Shared binder"** is on. Default binder is always `mine`.
- **Settings** (header gear → sheet) — General (default tax, Show Shared toggle) up
  top; **Advanced** collapse holds API keys (pokemontcg.io,
  PriceCharting, eBay), Monte-Carlo runs, packs-per-product, chase pull rates, and the
  pull-rate model JSON.
- **Refresh marker** — each set stores `lastRefresh`; the deal card shows "Updated {date}"
  and, after &gt;7 days, an amber "refresh recommended" nudge + highlighted Refresh button.

---

## When adding a feature
1. Build from the variables, two fonts, and components above. One hero accent per view.
2. Hub-first; respect the density rules (don't dump desk-detail onto mobile/Field).
3. Route verdicts through `verdict()`, money through `money()`, set identity through the
   set **number** + tint tile; rarity through the colored glyph set.
4. Keep derived stats **live from orders**; never persist static spend/packs/order counts.
5. New modal? Reuse the `.scrim`/`.sheet` (or `.confirm-card`) pattern.
6. No new fonts, no new top-level colors, no build step.

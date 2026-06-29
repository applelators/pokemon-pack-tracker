# Pack Tracker redesign — handoff to Claude Code

Drop these three files into the repo root:
- `Pack Tracker.html` — the reference prototype (self-contained vanilla JS, our no-build style). **Source of truth for the redesign.**
- `Pack Tracker — iPhone.html` — mobile / iPhone 17 Pro frame of the prototype.
- `CLAUDE.md` — updated project + design guide (read this first).

---

## Goal: port the redesign into the live app — 100%

Read `CLAUDE.md`, then study `Pack Tracker.html` and reproduce it exactly in
`public/index.html` + `public/app.js` + `public/styles.css`, wired to the real
Worker/D1 API instead of the prototype's mock data. Do the **full** redesign, not a
partial pass.

### Required scope
1. **Hub-first navigation** (`view: hub | set`). Land on the hub every load: art-forward
   list rows, **newest release first**, each with live completion% · packs-to-DR · spent ·
   orders, an inline quick deal-check (verdict + ± stepper), loose rip + last-refreshed,
   and Open / +Order / ↻Refresh. Prominent "+ Import a set" card. `← All sets` back from
   the set view.
2. **Multi-set orders** — move `set_id` from `orders` onto `order_items`. One receipt can
   span multiple expansions; the composer has one set picker per line. Update
   `computeOrder` and all order endpoints; migrate existing rows (see SQL below).
3. **Live set stats** — spent / packs / orders per set are **derived from orders**
   (filtered by binder, discounts + tax applied), never static columns. Update on every
   add/edit/delete.
4. **Deal check hero** — loose-pack + booster-bundle tabs, ±$1/±$5 stepper, live
   BUY/FAIR/PASS verdict + "buy ~N", resets to the set's market price on switch, and the
   **deal scale** bar (green/amber/red with labeled pointer). Cheapest rip floored at
   **$5** (`marketOf = max(5, market)`) everywhere.
5. **Diminishing returns** counts from packs **bought**, not opened.
6. **Completion** — gauge + editable "real card count" (overrides estimate, blank =
   default, show ±delta vs estimate); estimate headline = **to-95%** number.
7. **Desk detail** (desktop/Direction C; collapsed on mobile): estimate, chase odds,
   product breakdown, base-set rarity counts **with per-pack probability** (except
   Common/Uncommon = guaranteed).
8. **Pulls modal** (🃏 on each order row, separate from edit) — per-rarity steppers with
   live Binomial odds + tag-exact-cards grid; rows show "🃏 N pulls".
9. **Manage-sets sheet** — all expansions newest-first with loose rip · X/Y bought ·
   packs-to-DR, **✦ Special** (holo) and **"likely out of print"** badges, Import /
   Reimport / Remove; **block removal** when a set has orders/packs (untrack only, never
   delete data).
10. **Binder** Mine/Shared **hidden by default**; switch appears only when Settings →
    "Show Shared binder" is on; default always `mine`.
11. **Settings** sheet behind a header gear: General (tax, fun budget, Show Shared) +
    Advanced collapse (API keys, Monte-Carlo runs, packs-per-product, chase rates,
    pull-rate model JSON).
12. **Refresh marker** per set (`lastRefresh`): "Updated {date}", amber "refresh
    recommended" after 7 days.

### Constraints
- Keep the no-build vanilla-JS setup.
- Use only the `:root` tokens and the two fonts (Hanken Grotesk body / Space Grotesk for
  all numbers).
- Reuse the `.scrim`/`.sheet` + `.confirm-card` modal patterns.
- Route verdicts through `verdict()`, money through `money()`, set identity through the
  set-number tile.
- Ship **Direction C** as the production layout — the A/B/C switcher is a prototype-only
  comparison aid; drop or hide it.
- Keep animations quick and one-time per hub entry.
- The prototype's mock data (3 tracked sets, ~9 seed orders) is demo only — replace with
  real API calls; UI shapes + component CSS should match the prototype.

---

## Migration SQL — move `set_id` onto `order_items`

```sql
-- 1. Add the column (nullable first so the backfill can run)
ALTER TABLE order_items ADD COLUMN set_id TEXT REFERENCES sets(id);

-- 2. Backfill: every existing item inherits its order's set_id
UPDATE order_items
SET set_id = (SELECT o.set_id FROM orders o WHERE o.id = order_items.order_id)
WHERE set_id IS NULL;

-- 3. Index for the per-set live-stats queries
CREATE INDEX IF NOT EXISTS idx_order_items_set ON order_items(set_id);

-- 4. orders.set_id is now derived, not authoritative. D1/SQLite can't DROP COLUMN
--    cleanly on older engines, so leave the column in place but STOP writing/reading it.
--    (Optional, modern SQLite >= 3.35:)  ALTER TABLE orders DROP COLUMN set_id;
```

- New inserts must set `order_items.set_id` per line. An order with no items shouldn't exist.
- An order's "sets" = `SELECT DISTINCT set_id FROM order_items WHERE order_id = ?`.
- Per-set live stats: sum `qty*unit_price` over items where `set_id = ?`, apply the parent
  order's `discount_rate` + `tax_rate`, scope by `orders.collection`. Never read a stored
  spend/packs column.

---

## PR checklist

### Data / API
- [ ] Migration applied (local + remote); `order_items.set_id` backfilled + indexed.
- [ ] `POST /api/orders` accepts multi-set line items (each with `set_id`); `computeOrder`
      derives subtotal/packs/sets/total from lines.
- [ ] `PUT/DELETE /api/orders/:id` recompute all affected sets' stats.
- [ ] Per-set summary endpoint returns **live** spent/packs/orders (no static columns),
      filtered by `collection`.
- [ ] `marketOf(set) = max(5, market)` applied server- and client-side (verdict thresholds
      + display).
- [ ] Diminishing-returns uses packs **bought**; estimate headline = to-95%.
- [ ] `order_finds` + `order_pull_cards` still saved/edited independently of the order body.

### UI parity with `Pack Tracker.html`
- [ ] Hub-first (`view: hub|set`), newest-first art rows, inline quick deal-check, `← All sets` back.
- [ ] Deal hero: loose/bundle tabs, ±$1/±$5, resets price on set switch, **deal scale** bar.
- [ ] Editable "real card count" (delta vs estimate; blank = default placeholder).
- [ ] Desk detail: estimate, chase, product breakdown, rarity counts **with per-pack probability**.
- [ ] Pulls 🃏 modal separate from edit; "🃏 N pulls" chip on rows.
- [ ] Manage-sets: rip · X/Y bought · DR, **✦ Special** + **out-of-print** badges,
      Import/Reimport/Remove with **removal blocked** when orders/packs exist.
- [ ] Mine/Shared hidden unless Settings → "Show Shared binder"; default `mine`.
- [ ] Settings gear → sheet (General + Advanced collapse).
- [ ] Refresh marker (`lastRefresh`, >7-day "refresh recommended").

### System / polish
- [ ] Only `:root` tokens + Hanken/Space Grotesk; reuse `.scrim`/`.sheet`/`.confirm-card`.
- [ ] Direction C shipped as the layout; A/B/C switcher removed/hidden.
- [ ] Responsive: Desk on desktop, Field density ≤640px.
- [ ] Animations quick + one-time per hub entry.
- [ ] No build step; no new fonts/colors; `CLAUDE.md` updated (included).
- [ ] Delete confirm on orders; mock seed data replaced with real API.

# Pokémon TCG Collection & Binder Planner — Project Context

This file gives Claude Code full context on the Pokémon TCG collection-organization
work so it can extend it (e.g. build a binder-planner tool, a collection tracker, or
a ripping/tier-list UI) without re-deriving the rules. Structured data lives in
`data/collection.json`. A finished sortable tier-list UI already exists as
`pokemon-ripping-tierlist.html` (self-contained; can be rebuilt as a React component).

Owner is a completionist collector / content creator (@nabunan) who builds React
trackers deployed to Cloudflare Pages. Match that stack unless told otherwise.

---

## 1. Domain glossary

- **Master set** — every unique card in a set, including secret rares (the number
  we bind for; card counts below are master-set counts).
- **Main vs special set** — main-series expansions and "special" sets (e.g. 151,
  Paldean Fates, Prismatic) are collected in **separate binders**, never mixed.
- **Pocket / page-side** — one visible face of a binder page. Odd page-sides are
  right-hand pages, even are left-hand. A page-side holds `pocketsPerSide` cards.
- **Sheet** — one physical page = 2 page-sides (front + back).
- **Page-sides a set uses** = `ceil(setCards / pocketsPerSide)`.

---

## 2. Binder inventory (fixed hardware constraints)

| Capacity | Pocket layout | Pockets/side | Page-sides |
|---------:|:--------------|-------------:|-----------:|
| 160  | 4-pocket  | 4  | 40 |
| 360  | 9-pocket  | 9  | 40 |
| 480  | 12-pocket | 12 | 40 |
| 624  | 12-pocket | 12 | 52 |
| 1088 | 16-pocket | 16 | 68 |

`pageSides = capacity / pocketsPerSide`. These are the only binder sizes available.

---

## 3. Packing rules (the invariants any planner must honor)

1. **Whole sets, no straddling.** A set is stored entirely within one binder; it
   never continues into a second binder. A binder may hold multiple whole sets.
2. **New-page rule ("new page, any side").** Each set starts on a fresh page-side
   (left OR right — no requirement to start on a right page, and **no page is ever
   skipped**). The previous set's last page-side is rounded up; the next set begins
   on the following page-side.
   - Under this rule: `binderPageSidesUsed = Σ ceil(setCards_i / pocketsPerSide)`
     and must be `≤ capacity / pocketsPerSide`; also `Σ setCards ≤ capacity`.
   - A stricter **right-hand-start** variant also exists (each set must begin on an
     odd/right page, skipping a left page when the previous set ends on a right one).
     It costs more empty space and was **rejected for main series**. Only consider it
     if the user explicitly asks for right-page starts.
3. **Objective.** Minimize total empty pockets = `Σ capacities − Σ cards`. Tie-break
   on fewer binders.
4. Total empty pockets for a valid layout always equals `capacity − cards`; the rules
   only affect *whether it fits* and *where* the gaps fall, not the total count.

### Reference packing algorithm
Sets per binder are few, so brute force is fine: enumerate set-partitions, assign each
group the smallest binder whose `capacity ≥ groupCards` AND whose `pageSides ≥
Σ ceil(cards/perSide)` (new-page rule), sum capacities, keep the minimum (tie-break
fewer binders). A working Python version was used to produce the plans below.

---

## 4. Current collection & FINALIZED binder plans

All card counts are master-set totals. Plans below already satisfy §3.

### 4a. Scarlet & Violet — MAIN series → three 480 binders (12-pocket)
Grouping chosen for min empty space (74 total) + new-page rule. Order is
per-binder fill order.

| Binder | Sets (in order) | Cards | Empty | Page-sides |
|--------|-----------------|------:|------:|-----------:|
| 480 #1 | Twilight Masquerade (226) → Surging Sparks (252) | 478 | 2  | 40/40 |
| 480 #2 | Paldea Evolved (279) → Stellar Crown (175)       | 454 | 26 | 39/40 |
| 480 #3 | Journey Together (190) → Destined Rivals (244)   | 434 | 46 | 37/40 |

Note: Paldea Evolved is the constraint — at 279 it can only share a 480 with one of
the two smallest sets. Binder #3 holds the two newest sets (most growth room).

### 4b. Scarlet & Violet — SPECIAL sets → one 1088 binder (16-pocket)
Chronological order. Uses new-page rule → 63/68 page-sides, 111 empty (mostly the
5 blank pages at the back = growth room).

`151 (207) → Paldean Fates (245) → Prismatic (180) → Black Bolt + White Flare (345)`
= 977 cards.
(As originally delivered with the stricter right-page rule this used 64/68 with one
forced blank page after 151; the new-page rule above removes that blank page.)

### 4c. Mega Evolution — MAIN series → one 624 binder (12-pocket)
Release order. New-page rule → 49/52 page-sides, 60 empty (~3 blank pages at back).
Ascended Heroes is a SPECIAL set and is intentionally excluded here.

`Mega Evolution (188) → Phantasmal Flames (130) → Perfect Order (124) → Chaos Rising (122)`
= 564 cards.

### 4d. Future / undecided
- **Mega main, future sets** (Pitch Black 120, then Storm Emerald, etc.): the 624 in
  §4c is effectively full, so future sets need a **new binder**. Options: a second 624
  (~4 future main sets) or a 1088 (~8). Recommend matching 624s for a uniform shelf.
  You can't optimize fit yet (unknown future counts) — pick for runway, not tightness.
- **Mega special sets** (Ascended Heroes 295, future specials): own binder, TBD.
  Mirror the S&V special-set approach (§4b).

---

## 5. Booster-pack WRAPPER (pack-art) plan — separate from cards
- Owner also collects the unique **booster-pack wrapper art** per set.
- Wrappers are ~2.6" × 4.6–5" — **card-WIDTH but ~1.4–1.5× card-height**, so they do
  NOT fit card pockets (too tall). They must NOT go in the card binders above.
- Stored in **tarot sleeves** (~2.75" × 4.75") for now; destined for a **separate
  pack-art binder** with pack-sized pockets (~3.5"×5"+, ~6 per side, ~12/sheet).
- Scale is tiny: ~3–4 unique arts per main set, fewer for specials → ~38 wrappers
  total across the 10 S&V binder sets → ~3–4 sheets. Exact per-set art counts are
  **TBD** (a good data field to fill in: `wrapperArtCount`).

---

## 6. Sleeving & handling guidance (product rules, don't violate)
- **Do not penny-sleeve every card.** The pocket IS the protection. Penny sleeves
  break the fit of 12- and 16-pocket pages and ~double binder thickness (warps pages,
  strains rings). Sleeve/toploader **only the hits** (SIRs, chase cards).
- Use **PVC-free polypropylene, acid-free** pages. Page material matters more than an
  extra sleeve layer.
- If a fully-sleeved binder is ever wanted for one high-value set, use **9-pocket
  side-loading** pages with thin **perfect-fit** sleeves — never the 12/16-pocket pages.

---

## 7. Tier-list / ripping data
`data/collection.json` carries the "ripping & collecting" ranking (separate from card
counts): per-set tier, rank, top chase card + approx raw-NM USD value (June 2026
snapshot — volatile), approx any-SIR pull rate, and a **singles-vs-packs verdict**
(`Packs` / `Mixed` / `Singles`), plus a one-line rationale. S&V (15 sets) and Mega (5
sets) are ranked **separately**. Prices move fast — treat values as stale after ~a
month and re-fetch if building anything price-facing.

---

## 8. Files in this drop-in
- `CLAUDE.md` — this context doc.
- `data/collection.json` — machine-readable: binder types, all sets (counts, tier,
  value, rate, verdict, released), and the finalized binder assignments.
- `binderPlanner.js` — working implementation of the §3 packing algorithm (plain
  JS + JSDoc; runs in Node via `node binderPlanner.js`, importable into React).
  Exports `planBinders`, `buildPageMap`, `minBinderForGroup`, etc. Supports the
  `new-page` (default), `continuous`, and `right-page` rules.
- `pokemon-ripping-tierlist.html` — self-contained sortable tier-list UI (SV + Mega
  tabs, verdict column, expandable rationales). Good reference for a React port.

---

## 9. Build ideas (if asked to extend)
- Port the tier list to a React component matching the existing tracker style.
- Build an interactive **binder planner**: input sets + binder inventory, output the
  min-empty layout under §3, with a page-by-page map. `binderPlanner.js` already
  implements the algorithm — wrap it in a UI rather than rewriting it.
- A **completion tracker** per set (master-set checklist) tied to the binder position
  of each card.
- A **wrapper-art tracker** once per-set `wrapperArtCount`s are known.

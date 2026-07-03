/**
 * binderPlanner.js
 * ----------------------------------------------------------------------------
 * Whole-set binder packing planner for a TCG collection.
 * Implements the §3 rules from CLAUDE.md:
 *   - Whole sets, no straddling (a set lives entirely in one binder).
 *   - Page-alignment rule (default "new-page": each set starts on a fresh
 *     page-side, either side, no skipping).
 *   - Objective: minimize total empty pockets; tie-break on fewer binders.
 *
 * Runs standalone in Node ("node binderPlanner.js" prints a demo) AND is
 * importable into a React app. Plain JS + JSDoc types — no build step needed.
 * ----------------------------------------------------------------------------
 *
 * @typedef {Object} BinderType
 * @property {number} capacity        Total card capacity.
 * @property {number} pocketsPerSide  Cards per page-side (e.g. 12 for a 12-pocket page).
 *
 * @typedef {Object} SetInput
 * @property {string} name
 * @property {number} cards           Master-set card count.
 *
 * @typedef {"new-page"|"continuous"|"right-page"} PageRule
 */

/** Default binder inventory (matches collection.json / CLAUDE.md §2). */
export const DEFAULT_BINDERS = /** @type {BinderType[]} */ ([
  { capacity: 160, pocketsPerSide: 4 },
  { capacity: 360, pocketsPerSide: 9 },
  { capacity: 480, pocketsPerSide: 12 },
  { capacity: 624, pocketsPerSide: 12 },
  { capacity: 1088, pocketsPerSide: 16 },
]);

const ceilDiv = (a, b) => Math.ceil(a / b);
const pageSidesOfBinder = (b) => b.capacity / b.pocketsPerSide;

/** Page-sides one set occupies in a given pocket layout. */
export function setPageSides(cards, pocketsPerSide) {
  return ceilDiv(cards, pocketsPerSide);
}

/**
 * Page-sides a group of sets needs in a binder, under a page rule.
 * For "right-page" this depends on order, so the caller passes sets in the
 * intended fill order; the function accounts for skipped left pages.
 * @param {number[]} cardsInOrder
 * @param {number} perSide
 * @param {PageRule} rule
 */
export function groupPageSides(cardsInOrder, perSide, rule) {
  const total = cardsInOrder.reduce((a, c) => a + c, 0);
  if (rule === "continuous") return ceilDiv(total, perSide);
  if (rule === "new-page")
    return cardsInOrder.reduce((a, c) => a + setPageSides(c, perSide), 0);
  // right-page: each set must start on an odd (right) page-side; skip a left
  // page whenever the previous set ends on a right page.
  let pos = 1;
  let end = 0;
  for (const c of cardsInOrder) {
    const start = pos;
    end = start + setPageSides(c, perSide) - 1;
    pos = end % 2 === 1 ? end + 2 : end + 1; // next odd page-side
  }
  return end;
}

/**
 * Does a group of sets fit a binder under the rule?
 * For order-dependent rules we try the best ordering.
 */
export function groupFitsBinder(groupCards, binder, rule) {
  const total = groupCards.reduce((a, c) => a + c, 0);
  if (total > binder.capacity) return false;
  const cap = pageSidesOfBinder(binder);
  if (rule !== "right-page") {
    return groupPageSides(groupCards, binder.pocketsPerSide, rule) <= cap;
  }
  // right-page: succeed if ANY ordering fits.
  return permutations(groupCards).some(
    (order) => groupPageSides(order, binder.pocketsPerSide, rule) <= cap
  );
}

/** Smallest-capacity binder that fits a group, or null. */
export function minBinderForGroup(groupCards, binderTypes, rule) {
  return (
    [...binderTypes]
      .sort((a, b) => a.capacity - b.capacity)
      .find((b) => groupFitsBinder(groupCards, b, rule)) || null
  );
}

/** All set-partitions of an array (Bell number growth — keep item count small). */
export function partitions(items) {
  if (items.length === 0) return [[]];
  if (items.length === 1) return [[[items[0]]]];
  const [first, ...rest] = items;
  const out = [];
  for (const p of partitions(rest)) {
    for (let i = 0; i < p.length; i++) {
      out.push(p.map((g, j) => (j === i ? [first, ...g] : g)));
    }
    out.push([[first], ...p]);
  }
  return out;
}

/** Simple permutations (used only for small right-page groups). */
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((v, i) => {
    for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)]))
      out.push([v, ...p]);
  });
  return out;
}

/**
 * Plan the optimal binder assignment.
 * @param {SetInput[]} sets
 * @param {BinderType[]} [binderTypes]
 * @param {{rule?: PageRule}} [opts]
 * @returns {{binders: Array, totalEmpty: number, totalBinders: number, totalCards: number} | null}
 */
export function planBinders(sets, binderTypes = DEFAULT_BINDERS, opts = {}) {
  const rule = opts.rule || "new-page";
  if (sets.length > 9)
    console.warn(`planBinders: ${sets.length} sets — brute force may be slow.`);

  const totalCards = sets.reduce((a, s) => a + s.cards, 0);
  let best = null;

  for (const part of partitions(sets)) {
    let feasible = true;
    let capacity = 0;
    const binders = [];
    for (const group of part) {
      const cards = group.map((s) => s.cards);
      const binder = minBinderForGroup(cards, binderTypes, rule);
      if (!binder) {
        feasible = false;
        break;
      }
      capacity += binder.capacity;
      binders.push({ binder, sets: group });
    }
    if (!feasible) continue;
    const empty = capacity - totalCards;
    // minimize empty (== capacity), tie-break fewer binders
    if (
      !best ||
      empty < best.empty ||
      (empty === best.empty && binders.length < best.binders.length)
    ) {
      best = { empty, binders };
    }
  }
  if (!best) return null;

  return {
    totalCards,
    totalEmpty: best.empty,
    totalBinders: best.binders.length,
    binders: best.binders.map(({ binder, sets: grp }) => {
      const cards = grp.reduce((a, s) => a + s.cards, 0);
      return {
        capacity: binder.capacity,
        pocketsPerSide: binder.pocketsPerSide,
        sets: grp.map((s) => s.name),
        cards,
        empty: binder.capacity - cards,
        pageSidesUsed: groupPageSides(
          grp.map((s) => s.cards),
          binder.pocketsPerSide,
          rule
        ),
        pageSides: pageSidesOfBinder(binder),
        pageMap: buildPageMap(grp, binder.pocketsPerSide, rule),
      };
    }),
  };
}

/**
 * Page-by-page map for one binder (sets in fill order).
 * @returns {Array<{set:string,startPage:number,endPage:number,sides:number,lastPageFill:number,startsOn:"right"|"left",skipAfter:boolean}>}
 */
export function buildPageMap(setsInOrder, perSide, rule = "new-page") {
  const map = [];
  let pos = 1;
  for (const s of setsInOrder) {
    const sides = setPageSides(s.cards, perSide);
    const start = pos;
    const end = start + sides - 1;
    const lastPageFill = s.cards - (sides - 1) * perSide;
    let skipAfter = false;
    if (rule === "right-page" && end % 2 === 1) {
      skipAfter = true; // a left page is left blank before the next set
      pos = end + 2;
    } else {
      pos = end + 1;
    }
    map.push({
      set: s.name,
      startPage: start,
      endPage: end,
      sides,
      lastPageFill,
      startsOn: start % 2 === 1 ? "right" : "left",
      skipAfter,
    });
  }
  return map;
}

/* --------------------------------------------------------------------------
 * DEMO — runs only when executed directly: `node binderPlanner.js`
 * Reproduces the finalized plans from the collection.
 * ------------------------------------------------------------------------ */
function runDemo() {
  const scenarios = [
    {
      title: "Scarlet & Violet — MAIN series",
      sets: [
        { name: "Paldea Evolved", cards: 279 },
        { name: "Twilight Masquerade", cards: 226 },
        { name: "Stellar Crown", cards: 175 },
        { name: "Surging Sparks", cards: 252 },
        { name: "Journey Together", cards: 190 },
        { name: "Destined Rivals", cards: 244 },
      ],
    },
    {
      title: "Scarlet & Violet — SPECIAL sets",
      sets: [
        { name: "151", cards: 207 },
        { name: "Paldean Fates", cards: 245 },
        { name: "Prismatic Evolutions", cards: 180 },
        { name: "Black Bolt + White Flare", cards: 345 },
      ],
    },
    {
      title: "Mega Evolution — MAIN series",
      sets: [
        { name: "Mega Evolution", cards: 188 },
        { name: "Phantasmal Flames", cards: 130 },
        { name: "Perfect Order", cards: 124 },
        { name: "Chaos Rising", cards: 122 },
      ],
    },
  ];

  for (const { title, sets } of scenarios) {
    const plan = planBinders(sets, DEFAULT_BINDERS, { rule: "new-page" });
    console.log(`\n=== ${title} ===`);
    console.log(
      `${plan.totalCards} cards → ${plan.totalBinders} binder(s), ${plan.totalEmpty} empty pockets`
    );
    for (const b of plan.binders) {
      console.log(
        `  [${b.capacity} · ${b.pocketsPerSide}-pocket] ${b.sets.join(
          " → "
        )}  (${b.cards} cards, ${b.empty} empty, ${b.pageSidesUsed}/${b.pageSides} pages)`
      );
      for (const p of b.pageMap) {
        console.log(
          `       ${p.set}: pages ${p.startPage}-${p.endPage} ` +
            `(last page ${p.lastPageFill}/${b.pocketsPerSide})`
        );
      }
    }
  }
}

// Run the demo only when invoked directly (not when imported).
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  runDemo();
}

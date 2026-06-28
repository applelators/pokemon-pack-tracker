// Rarity-weighted Monte Carlo estimate of how many booster packs are needed to
// collect every card in a set's base (numbered) checklist. Pure JS — runs both
// in Node and on Cloudflare Workers.
//
// Model: the base set is a pool of distinct "coupons", one per numbered card,
// grouped by rarity. A booster is a list of slots; each slot draws one card.
//   - pool slot:    uniform pick across all cards in the listed rarities
//   - weighted slot: pick a rarity by weight, then a uniform card within it
// Any base-set rarity not reachable by some slot is folded into the weighted
// "hit" slot (weight proportional to its card count) so completion is possible.

function buildDraws(rarities, packModel) {
  const counts = {};
  let N = 0;
  for (const { rarity, count } of rarities) {
    counts[rarity] = (counts[rarity] || 0) + count;
    N += count;
  }

  // Assign a contiguous global index range to each rarity.
  const ranges = {};
  let cursor = 0;
  for (const [rarity, count] of Object.entries(counts)) {
    ranges[rarity] = { start: cursor, size: count };
    cursor += count;
  }

  const slots = packModel.slots || [];
  const reachable = new Set();
  let weightedSlot = null;
  for (const slot of slots) {
    if (slot.pool) for (const r of slot.pool) if (counts[r]) reachable.add(r);
    if (slot.weights) {
      weightedSlot = slot;
      for (const r of Object.keys(slot.weights)) if (counts[r]) reachable.add(r);
    }
  }

  const unreachable = Object.keys(counts).filter((r) => !reachable.has(r));
  const foldTarget = weightedSlot || slots[0];

  const compiled = [];
  for (const slot of slots) {
    const repeat = slot.count || 1;
    if (slot.weights || slot === foldTarget) {
      const weights = { ...(slot.weights || {}) };
      if (slot === foldTarget) {
        for (const r of unreachable) weights[r] = (weights[r] || 0) + counts[r];
      }
      const entries = Object.entries(weights).filter(([r]) => counts[r]);
      const totalW = entries.reduce((a, [, w]) => a + w, 0) || 1;
      const cum = [];
      let acc = 0;
      for (const [r, w] of entries) {
        acc += w / totalW;
        cum.push({ rarity: r, threshold: acc, range: ranges[r] });
      }
      if (cum.length) compiled.push({ type: "weighted", repeat, cum });
    } else if (slot.pool) {
      const present = slot.pool.filter((r) => counts[r]);
      const size = present.reduce((a, r) => a + counts[r], 0);
      if (size > 0) compiled.push({ type: "pool", repeat, present, size, ranges });
    }
  }

  return { N, compiled };
}

function drawInto(compiled, collected) {
  let fresh = 0;
  for (const slot of compiled) {
    for (let i = 0; i < slot.repeat; i++) {
      let idx;
      if (slot.type === "weighted") {
        const r = Math.random();
        let chosen = slot.cum[slot.cum.length - 1];
        for (const c of slot.cum) {
          if (r <= c.threshold) { chosen = c; break; }
        }
        idx = chosen.range.start + Math.floor(Math.random() * chosen.range.size);
      } else {
        let pick = Math.floor(Math.random() * slot.size);
        idx = 0;
        for (const rar of slot.present) {
          const rg = slot.ranges[rar];
          if (pick < rg.size) { idx = rg.start + pick; break; }
          pick -= rg.size;
        }
      }
      if (collected[idx] === 0) { collected[idx] = 1; fresh++; }
    }
  }
  return fresh;
}

// Heavy part — depends only on (rarities, packModel, runs), so it's cache-able.
// Returns the averaged collection curve + completion stats. `opened`/`collected`
// are applied cheaply afterwards by applyProgress().
export function computeCurve({ rarities, packModel, runs = 3000 }) {
  const { N, compiled } = buildDraws(rarities, packModel);
  const CURVE_CAP = 4000;
  if (N === 0 || compiled.length === 0) {
    return { N: 0, expectedTotalPacks: 0, p50: 0, p90: 0, diminishingReturnsPacks: 0,
      diminishingReturnsPacksSteep: 0, setMilestones: { pct50: null, pct90: null, pct95: null }, curve: [0] };
  }
  const MAX_PACKS = 500000;
  const curveSum = new Float64Array(CURVE_CAP + 1);
  const totals = new Array(runs);

  for (let run = 0; run < runs; run++) {
    const collected = new Uint8Array(N);
    let distinct = 0, packs = 0;
    while (distinct < N && packs < MAX_PACKS) {
      distinct += drawInto(compiled, collected);
      packs++;
      if (packs <= CURVE_CAP) curveSum[packs] += distinct;
    }
    for (let k = packs + 1; k <= CURVE_CAP; k++) curveSum[k] += N;
    totals[run] = packs;
  }

  totals.sort((a, b) => a - b);
  const mean = totals.reduce((a, b) => a + b, 0) / runs;
  const pct = (p) => totals[Math.min(runs - 1, Math.floor(p * runs))];
  const curve = new Array(CURVE_CAP + 1);
  for (let k = 0; k <= CURVE_CAP; k++) curve[k] = curveSum[k] / runs;

  const firstBelow = (t) => { for (let k = 1; k <= CURVE_CAP; k++) if (curve[k] - curve[k - 1] < t) return k; return null; };
  const packsTo = (target) => { for (let k = 1; k <= CURVE_CAP; k++) if (curve[k] >= target) return k; return null; };

  // Compact, cache-friendly projections of the curve (instead of all 4001 points):
  //   fwd[k] = expected distinct after k packs (k = 0..FWD_CAP)
  //   inv[c] = packs to reach c distinct cards (c = 0..N)
  const FWD_CAP = Math.min(1000, CURVE_CAP);
  const fwd = [];
  for (let k = 0; k <= FWD_CAP; k++) fwd.push(Math.round(curve[k] * 100) / 100);
  const inv = new Array(N + 1);
  let kk = 0;
  for (let c = 0; c <= N; c++) {
    while (kk < CURVE_CAP && curve[kk] < c) kk++;
    inv[c] = kk;
  }

  return {
    N,
    expectedTotalPacks: Math.round(mean),
    p50: pct(0.5),
    p90: pct(0.9),
    diminishingReturnsPacks: firstBelow(1) ?? CURVE_CAP,
    diminishingReturnsPacksSteep: firstBelow(0.2) ?? CURVE_CAP,
    setMilestones: { pct50: packsTo(0.5 * N), pct90: packsTo(0.9 * N), pct95: packsTo(0.95 * N) },
    fwd, inv,
  };
}

// Cheap — apply the user's opened-packs / cards-collected to a (cached) curve.
export function applyProgress(cc, opened = 0, collected = null) {
  const N = cc.N || 0;
  const base = {
    baseSetSize: N, expectedTotalPacks: cc.expectedTotalPacks || 0,
    p50: cc.p50 || 0, p90: cc.p90 || 0,
    diminishingReturnsPacks: cc.diminishingReturnsPacks, diminishingReturnsPacksSteep: cc.diminishingReturnsPacksSteep,
    setMilestones: cc.setMilestones || { pct50: null, pct90: null, pct95: null },
    expectedCollectedAtOpened: 0, expectedPctAtOpened: 0, packsRemaining: 0,
    collected: null, actualPct: null, cardsRemaining: null, equivalentPacks: null, packsRemainingFromCards: null,
    opened,
  };
  if (!N) return base;
  const fwd = cc.fwd || [0];
  const colAtOpened = opened <= 0 ? 0 : (opened < fwd.length ? fwd[opened] : N);
  base.expectedCollectedAtOpened = Math.round(colAtOpened);
  base.expectedPctAtOpened = Math.round((colAtOpened / N) * 1000) / 10;
  base.packsRemaining = Math.max(0, Math.round(cc.expectedTotalPacks - opened));
  if (collected != null && collected >= 0) {
    const c = Math.min(collected, N);
    base.collected = c;
    base.actualPct = Math.round((c / N) * 1000) / 10;
    base.cardsRemaining = Math.max(0, N - c);
    const inv = cc.inv || [];
    const eq = c >= N ? cc.expectedTotalPacks : (inv[c] != null ? inv[c] : 0);
    base.equivalentPacks = eq;
    base.packsRemainingFromCards = Math.max(0, Math.round(cc.expectedTotalPacks - eq));
  }
  return base;
}

export function estimate({ rarities, packModel, opened = 0, runs = 3000, collected = null }) {
  return applyProgress(computeCurve({ rarities, packModel, runs }), opened, collected);
}

// Average packs to pull a chase card (Illustration Rare, Ultra Rare, Special
// Illustration Rare, Mega Hyper Rare, ...). Each rarity has an editable per-pack
// probability; average packs to the first = 1/p (geometric mean). `presentRarities`
// (if provided) limits the combined "any chase" figure to rarities actually in the set.
export function chaseEstimate({ rates, presentRarities }) {
  const ABBR = {
    "Illustration Rare": "IR",
    "Ultra Rare": "UR",
    "Special Illustration Rare": "SIR",
    "Mega Hyper Rare": "MHR",
    "Hyper Rare": "HR",
  };
  const items = [];
  let probNone = 1;
  for (const [rarity, raw] of Object.entries(rates || {})) {
    const p = Number(raw);
    if (!(p > 0)) continue;
    const present = !presentRarities || presentRarities.has(rarity);
    items.push({
      rarity,
      abbr: ABBR[rarity] || rarity,
      perPackProb: p,
      avgPacks: Math.round(1 / p),
      present,
    });
    if (present) probNone *= 1 - p;
  }
  items.sort((a, b) => b.perPackProb - a.perPackProb);
  const anyProb = 1 - probNone;
  return {
    items,
    anyPerPackProb: anyProb,
    anyAvgPacks: anyProb > 0 ? Math.round(1 / anyProb) : null,
  };
}

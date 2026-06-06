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

export function estimate({ rarities, packModel, opened = 0, runs = 3000 }) {
  const { N, compiled } = buildDraws(rarities, packModel);
  if (N === 0 || compiled.length === 0) {
    return { baseSetSize: N, expectedTotalPacks: 0, packsRemaining: 0,
      p50: 0, p90: 0, expectedCollectedAtOpened: 0, expectedPctAtOpened: 0,
      runs: 0, opened };
  }

  const MAX_PACKS = 500000;
  // Track the average collection curve up to CURVE_CAP packs so we can find the
  // "diminishing returns" point and set-completion milestones (which all occur
  // well before 100% completion).
  const CURVE_CAP = 4000;
  const curveSum = new Float64Array(CURVE_CAP + 1); // curveSum[k] = sum of distinct after k packs
  const totals = new Array(runs);
  let sumCollectedAtOpened = 0;

  for (let run = 0; run < runs; run++) {
    const collected = new Uint8Array(N);
    let distinct = 0;
    let packs = 0;
    let snapped = opened === 0;

    while (distinct < N && packs < MAX_PACKS) {
      distinct += drawInto(compiled, collected);
      packs++;
      if (packs <= CURVE_CAP) curveSum[packs] += distinct;
      if (!snapped && packs === opened) {
        sumCollectedAtOpened += distinct;
        snapped = true;
      }
    }
    if (!snapped) sumCollectedAtOpened += N;
    // Once complete, the curve stays at N for the rest of the window.
    for (let k = packs + 1; k <= CURVE_CAP; k++) curveSum[k] += N;
    totals[run] = packs;
  }

  totals.sort((a, b) => a - b);
  const mean = totals.reduce((a, b) => a + b, 0) / runs;
  const pct = (p) => totals[Math.min(runs - 1, Math.floor(p * runs))];
  const expectedCollectedAtOpened = sumCollectedAtOpened / runs;

  // Average curve + derived metrics.
  const curve = new Array(CURVE_CAP + 1);
  for (let k = 0; k <= CURVE_CAP; k++) curve[k] = curveSum[k] / runs;

  // Diminishing returns: first pack whose marginal expected new base-set cards
  // drops below 1 (i.e. on average the next pack is mostly duplicates).
  let diminishingReturnsPacks = CURVE_CAP;
  for (let k = 1; k <= CURVE_CAP; k++) {
    if (curve[k] - curve[k - 1] < 1) { diminishingReturnsPacks = k; break; }
  }
  // Packs to collect a given fraction of the whole base set.
  const packsToPct = (frac) => {
    const target = frac * N;
    for (let k = 1; k <= CURVE_CAP; k++) if (curve[k] >= target) return k;
    return null; // not reached within the window
  };

  return {
    baseSetSize: N,
    expectedTotalPacks: Math.round(mean),
    packsRemaining: Math.max(0, Math.round(mean - opened)),
    p50: pct(0.5),
    p90: pct(0.9),
    expectedCollectedAtOpened: Math.round(expectedCollectedAtOpened),
    expectedPctAtOpened: Math.round((expectedCollectedAtOpened / N) * 1000) / 10,
    diminishingReturnsPacks,
    setMilestones: { pct50: packsToPct(0.5), pct90: packsToPct(0.9), pct95: packsToPct(0.95) },
    runs,
    opened,
  };
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

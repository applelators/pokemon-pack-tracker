// Custom sets that don't exist on pokemontcg.io — currently the First Partner
// Illustration Collection 2026 (30th-anniversary promo series).
//
// Structure (per series): 9 Illustration Rare promos = 3 regions × a 3-card
// connected-panorama trio. One promo pack per $14.99 box, and the pack is
// REGION-LOCKED: it contains one region's complete trio, region ~uniform 1/3.
// So completion is a 3-coupon collector problem, not a normal booster model —
// the completion curve below is analytic, not Monte-Carlo.

export const CUSTOM_SETS = {
  fp1: {
    name: "First Partner — Series 1",
    series: "First Partner 2026",
    release_date: "2026/03/30",
    regions: [
      ["Kanto", ["Bulbasaur", "Charmander", "Squirtle"]],
      ["Sinnoh", ["Turtwig", "Chimchar", "Piplup"]],
      ["Alola", ["Rowlet", "Litten", "Popplio"]],
    ],
  },
  fp2: {
    name: "First Partner — Series 2",
    series: "First Partner 2026",
    release_date: "2026/06/19",
    regions: [
      ["Johto", ["Chikorita", "Cyndaquil", "Totodile"]],
      ["Unova", ["Snivy", "Tepig", "Oshawott"]],
      ["Galar", ["Grookey", "Scorbunny", "Sobble"]],
    ],
  },
  fp3: {
    name: "First Partner — Series 3",
    series: "First Partner 2026",
    release_date: "2026/08/07",
    regions: [
      ["Hoenn", ["Treecko", "Torchic", "Mudkip"]],
      ["Kalos", ["Chespin", "Fennekin", "Froakie"]],
      ["Paldea", ["Sprigatito", "Fuecoco", "Quaxly"]],
    ],
  },
};

// Card list in binder order (region trios in printed order), numbered 1–9.
export function customCards(id) {
  const def = CUSTOM_SETS[id];
  if (!def) return null;
  const out = [];
  let n = 0;
  for (const [region, mons] of def.regions) {
    for (const mon of mons) {
      n += 1;
      out.push({ id: `${id}-${n}`, name: `${mon} (${region})`, number: String(n), rarity: "Promo", image: null });
    }
  }
  return out;
}

// Analytic completion curve for the region-locked trio model, in the same compact
// shape the Monte-Carlo estimator caches (fwd/inv + breakpoints + milestones).
// Expected distinct cards after k packs: 9·(1 − (2/3)^k).
export function customCurve(id) {
  if (!CUSTOM_SETS[id]) return null;
  const N = 9, CAP = 400;
  const fwd = [0];
  for (let k = 1; k <= CAP; k++) fwd.push(Math.round(9 * (1 - Math.pow(2 / 3, k)) * 100) / 100);
  const inv = new Array(N + 1);
  let kk = 0;
  for (let c = 0; c <= N; c++) { while (kk < CAP && fwd[kk] < c) kk++; inv[c] = kk; }
  const firstBelow = (t) => { for (let k = 1; k <= CAP; k++) if (fwd[k] - fwd[k - 1] < t) return k; return CAP; };
  const packsTo = (target) => { for (let k = 1; k <= CAP; k++) if (fwd[k] >= target) return k; return null; };
  return {
    N,
    expectedTotalPacks: 5.5,               // 3·(1 + 1/2 + 1/3) boxes to see all 3 regions
    p50: 5,                                // median boxes to complete
    p90: 10,                               // unlucky run
    diminishingReturnsPacks: firstBelow(1),      // 4 — box 4 expects < 1 new card
    diminishingReturnsPacksSteep: firstBelow(0.2), // 8
    setMilestones: { pct50: packsTo(0.5 * N), pct90: packsTo(0.9 * N), pct95: packsTo(0.95 * N) },
    fwd, inv,
  };
}

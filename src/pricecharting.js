// PriceCharting client — fetches the loose (sealed) booster-pack market price
// for a set. Requires a paid PriceCharting API token (stored in settings).
import { getRawSettings } from "./store.js";

const BASE = "https://www.pricecharting.com/api";

async function pcProducts(db, query) {
  const token = ((await getRawSettings(db)).pricecharting_api_key || "").trim();
  if (!token) throw new Error("No PriceCharting API key set — add it in Settings.");
  const url = `${BASE}/products?t=${encodeURIComponent(token)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`PriceCharting ${res.status}: ${b.slice(0, 120)}`);
  }
  const data = await res.json();
  return data.products || (data["product-name"] ? [data] : []);
}

function pickBoosterPack(products, setName) {
  const sn = (setName || "").toLowerCase();
  const norm = (p) => ({
    id: p.id,
    name: p["product-name"] || "",
    console: p["console-name"] || "",
    loose: p["loose-price"],
    neu: p["new-price"],
  });
  const list = (products || []).map(norm).filter((p) => p.console.toLowerCase().includes("pokemon"));
  // a single loose pack: name has "booster pack" but isn't a box/bundle/case/etc.
  const isPlainPack = (p) => /booster pack/i.test(p.name) && !/(box|bundle|case|sleeved|blister|tin|collection|elite)/i.test(p.name);
  const score = (p) => (isPlainPack(p) ? 2 : 0) + (p.console.toLowerCase().includes(sn) ? 1 : 0);
  list.sort((a, b) => score(b) - score(a));
  return list.find((p) => isPlainPack(p)) || list[0] || null;
}

// Returns { market, productName, consoleName, productId } or { market:null, note }.
export async function fetchPackPrice(db, setName) {
  const products = await pcProducts(db, `pokemon ${setName} booster pack`);
  const p = pickBoosterPack(products, setName);
  if (!p) return { market: null, note: `No PriceCharting match for "${setName} booster pack".` };
  const cents = p.loose != null ? p.loose : p.neu;
  const market = cents != null ? Math.round(cents) / 100 : null;
  return { market, productName: p.name, consoleName: p.console, productId: p.id };
}

// eBay Browse API — median asking price of single loose booster packs for a set.
// Needs a free eBay developer app: client id + secret in settings.
import { getRawSettings } from "./store.js";

export async function ebayAppToken(db) { return appToken(db); }

async function appToken(db) {
  const s = await getRawSettings(db);
  const id = (s.ebay_client_id || "").trim();
  const secret = (s.ebay_client_secret || "").trim();
  if (!id || !secret) return null;
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${id}:${secret}`),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`eBay auth ${res.status}: ${b.slice(0, 120)}`);
  }
  return (await res.json()).access_token;
}

// Junk listings that poison a product-price median regardless of product type.
const JUNK = /(japanese|korean|chinese|empty|no\s*packs?|opened|resealed|damaged|custom|proxy|repack|box only|art only|read desc|\blots?\b|bulk)/i;
// For single-pack queries, also reject anything bigger than one pack (x10 lots,
// boxes, bundles…) — same guard fetchEbayPackPrice uses. Only applied when the
// query itself ends in "booster pack", so "3 Pack Blister" queries stay unharmed.
const MULTI = /(box|bundle|case|etb|elite|collection|tin|display|blister|\bx\s*\d|\d+\s*(packs?|ct|count)\b)/i;

// Median asking price for ONE sealed product (query = product name). Asking ≠ sold:
// callers must label this "ask". Returns { median, n } or null when nothing usable.
export async function fetchEbayAskPrice(token, query) {
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent("pokemon " + query)}&filter=buyingOptions:%7BFIXED_PRICE%7D&limit=25`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  if (!res.ok) throw new Error(`eBay ${res.status}`);
  const items = (await res.json()).itemSummaries || [];
  // Require the product's most distinctive tokens in the title (words ≥ 4 chars,
  // ignoring brackets/punctuation) so "Chaos Rising ETB" hits don't count for packs.
  const need = (query.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 4);
  const singlePack = /booster pack$/i.test(query.trim());
  const prices = items
    .filter((i) => {
      const t = (i.title || "").toLowerCase();
      return !JUNK.test(t) && !(singlePack && MULTI.test(t)) && need.every((w) => t.includes(w));
    })
    .map((i) => Number(i.price && i.price.value))
    .filter((v) => v > 2 && v < 5000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const m = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2;
  return { median: Math.round(median * 100) / 100, n: prices.length };
}

// Median asking price of single-pack listings (filters out boxes/bundles/lots).
export async function fetchEbayPackPrice(db, setName) {
  const token = await appToken(db);
  if (!token) return null;
  const q = `pokemon ${setName} booster pack`;
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:%7BFIXED_PRICE%7D&limit=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`eBay ${res.status}: ${b.slice(0, 120)}`);
  }
  const items = (await res.json()).itemSummaries || [];
  const EXCLUDE = /(box|bundle|lot|case|etb|elite|collection|tin|booster\s*display|\bx\s?\d|\d+\s*pack)/i;
  const prices = items
    .filter((i) => /booster pack/i.test(i.title || "") && !EXCLUDE.test(i.title || ""))
    .map((i) => Number(i.price && i.price.value))
    .filter((v) => v > 0 && v < 1000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const m = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2;
  return { median: Math.round(median * 100) / 100, n: prices.length };
}

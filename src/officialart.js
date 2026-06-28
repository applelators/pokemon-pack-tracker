// Best-effort scrape of a set's official art from its tcg.pokemon.com expansion
// page (key-art hero + product renders). Returns { hero, products } or null.
const CDN_RE = /https:\/\/[a-z0-9.]+cloudfront\.net\/assets\/img\/[A-Za-z0-9._/-]+\.(?:png|jpg|jpeg)/g;

function slugify(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function humanize(token) {
  return token.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const PRODUCT_LABELS = {
  "etb": "Elite Trainer Box",
  "pc-etb": "Pokémon Center ETB",
  "etb-pc": "Pokémon Center ETB",
  "build-battle": "Build & Battle Box",
  "booster-bundle": "Booster Bundle",
  "booster-display": "Booster Display",
  "sleeved-boosters": "Sleeved Boosters",
  "accessory-pouch": "Accessory Pouch",
  "suprise-box": "Surprise Box",
  "surprise-box": "Surprise Box",
  "binder": "Binder Collection",
  "poster": "Poster Collection",
};
function productLabel(mid) {
  return PRODUCT_LABELS[mid] || humanize(mid);
}

export async function fetchOfficialArt(name) {
  const slug = slugify(name);
  if (!slug) return null;
  let html;
  try {
    const res = await fetch(`https://tcg.pokemon.com/en-us/expansions/${slug}/`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const urls = [...new Set(html.match(CDN_RE) || [])].filter((u) => !/-2x\./.test(u));

  // Hero: a page header image — prefer a medium, then large, then any.
  const headers = urls.filter((u) => /\/header\//.test(u));
  const byKw = (arr, kw) => arr.find((u) => u.includes(kw));
  const hero = byKw(headers, "medium") || byKw(headers, "large") || byKw(headers, "small") || headers[0] || null;

  // Products: this page's sealed-product renders.
  const products = [];
  const seen = new Set();
  for (const u of urls.filter((x) => /\/collections\/en-us\/.+\.png$/.test(x))) {
    const file = u.split("/").pop().replace(/\.png$/, "");   // e.g. me04-booster-bundle-en
    const mid = file.replace(/-en$/, "").replace(/^[a-z0-9]+-/i, ""); // strip code prefix -> booster-bundle
    const label = productLabel(mid);
    if (label && !seen.has(label)) { seen.add(label); products.push({ name: label, img: u }); }
  }

  if (!hero && !products.length) return null;
  return { hero, products: products.slice(0, 8) };
}

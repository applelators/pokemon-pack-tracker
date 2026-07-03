#!/usr/bin/env python3
"""
Multi-source "what's still in print?" checker for the Pokémon pack tracker.

Sources (all machine-checkable; X/Twitter blocks scraping so alert accounts
stay a manual glance):
  1. r/PKMNTCGDeals    — deal/restock posts (Reddit RSS; JSON is 403-blocked)
  2. r/PokemonTCGDeals — sibling deals sub
  3. Google News RSS   — reprint/restock articles (indexes PokeBeach/IGN/ICv2/…)

Usage:  python3 tools/print_status_check.py [--days 120]
Output: per-set signal table + suggested changes vs PRINT_STATUS in public/app.js.
Run it on demand; update PRINT_STATUS manually when the picture changes.
"""
import urllib.request, urllib.error, urllib.parse, xml.etree.ElementTree as ET
import re, sys, time, datetime, email.utils

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
DAYS = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 120
CUTOFF = (datetime.datetime.now() - datetime.timedelta(days=DAYS)).strftime("%Y-%m-%d")

# set label -> (title regex, tracker id, released)
SETS = {
    "Prismatic Evolutions": (r"prismatic", "sv8pt5", "2025-01"),
    "151":                  (r"\b151\b", "sv3pt5", "2023-09"),
    "Paldean Fates":        (r"paldean fates", "sv4pt5", "2024-01"),
    "Surging Sparks":       (r"surging", "sv8", "2024-11"),
    "Twilight Masquerade":  (r"twilight", "sv6", "2024-05"),
    "Stellar Crown":        (r"stellar crown|stellar", "sv7", "2024-09"),
    "Journey Together":     (r"journey", "sv9", "2025-03"),
    "Destined Rivals":      (r"destined", "sv10", "2025-05"),
    "Paldea Evolved":       (r"paldea evolved", "sv2", "2023-06"),
    "Black Bolt":           (r"black ?bolt", "zsv10pt5", "2025-07"),
    "White Flare":          (r"white ?flare", "rsv10pt5", "2025-07"),
    "Mega Evolution (ME01)":(r"mega evolution\b|me01", "me1", "2025-09"),
    "Phantasmal Flames":    (r"phantasmal", "me2", "2025-11"),
    "Ascended Heroes":      (r"ascended", "me2pt5", "2026-01"),
    "Perfect Order":        (r"perfect order", "me3", "2026-03"),
    "Chaos Rising":         (r"chaos rising", "me4", "2026-05"),
    "Paradox Rift":         (r"paradox", "sv4", "2023-11"),
    "Temporal Forces":      (r"temporal", "sv5", "2024-03"),
    "Shrouded Fable":       (r"shrouded", "sv6pt5", "2024-08"),
    "Obsidian Flames":      (r"obsidian", "sv3", "2023-08"),
}
SKIP = re.compile(r"weekly|megathread|q&a|giveaway", re.I)

def fetch(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < tries - 1:
                w = 30 * (i + 1); print(f"    429 — waiting {w}s…", file=sys.stderr); time.sleep(w); continue
            raise

def reddit_posts(sub, pages=2):
    out, after = [], None
    for _ in range(pages):
        url = f"https://www.reddit.com/r/{sub}/new.rss?limit=100" + (f"&after={after}" if after else "")
        root = ET.fromstring(fetch(url))
        entries = root.findall("a:entry", ATOM)
        if not entries: break
        for e in entries:
            out.append({"title": e.findtext("a:title", "", ATOM),
                        "date": (e.findtext("a:published", "", ATOM) or "")[:10],
                        "src": f"r/{sub}"})
        after = entries[-1].findtext("a:id", "", ATOM)
        time.sleep(6)
    return out

def gnews(query):
    url = "https://news.google.com/rss/search?q=" + urllib.parse.quote(query) + "&hl=en-US&gl=US&ceid=US:en"
    root = ET.fromstring(fetch(url))
    out = []
    for it in root.findall(".//item"):
        try: d = email.utils.parsedate_to_datetime(it.findtext("pubDate", "")).strftime("%Y-%m-%d")
        except Exception: d = ""
        out.append({"title": it.findtext("title", ""), "date": d, "src": "news"})
    return out

posts = []
for sub in ("PKMNTCGDeals", "PokemonTCGDeals"):
    try:
        got = reddit_posts(sub); posts += got
        print(f"  {sub}: {len(got)} posts", file=sys.stderr)
    except Exception as e:
        print(f"  {sub}: FAILED ({e})", file=sys.stderr)
    time.sleep(6)
try:
    got = gnews('"pokemon tcg" (reprint OR restock OR "back in stock")')
    posts += got; print(f"  google news (general): {len(got)} items", file=sys.stderr)
except Exception as e: print(f"  google news: FAILED ({e})", file=sys.stderr)
# targeted news per set (catches set-specific articles the general query misses)
for label in SETS:
    q = f'pokemon "{label.split(" (")[0]}" (restock OR reprint OR "back in stock" OR "in stock")'
    try: posts += gnews(q)
    except Exception: pass
    time.sleep(1.2)

seen, hits = set(), {k: {"n": 0, "last": "0000", "srcs": set(), "ex": []} for k in SETS}
for p in posts:
    key = (p["title"], p["src"])
    if key in seen or not p["date"] or p["date"] < CUTOFF or SKIP.search(p["title"]): continue
    seen.add(key)
    low = p["title"].lower()
    # News source: only count stock/print-relevant articles (skip price/value pieces).
    if p["src"] == "news" and not re.search(r"restock|reprint|back in stock|in stock|where to buy|available|out of print|print run", low):
        continue
    for label, (rx, _, _) in SETS.items():
        if re.search(rx, low):
            h = hits[label]; h["n"] += 1; h["last"] = max(h["last"], p["date"]); h["srcs"].add(p["src"])
            if len(h["ex"]) < 2: h["ex"].append(f'{p["date"]} [{p["src"]}] {p["title"][:80]}')

print(f"\n=== Print-status signals · last {DAYS} days · {len(seen)} unique dated items ===\n")
print("%-24s %5s  %-10s %-28s %s" % ("set", "hits", "latest", "sources", "suggested read"))
for label, h in sorted(hits.items(), key=lambda kv: -kv[1]["n"]):
    _, sid, rel = SETS[label]
    age_months = (datetime.datetime.now() - datetime.datetime.strptime(rel, "%Y-%m")).days // 30
    if h["n"] >= 3: verdict = "IN PRINT (active)"
    elif h["n"] >= 1: verdict = "some activity"
    elif age_months <= 14: verdict = "quiet — likely in print (recent set, selling at MSRP)"
    else: verdict = "quiet — likely OUT of print"
    print("%-24s %5d  %-10s %-28s %s" % (label, h["n"], h["last"] if h["n"] else "—", "+".join(sorted(h["srcs"])) or "—", verdict))
print("\n== samples ==")
for label, h in sorted(hits.items(), key=lambda kv: -kv[1]["n"]):
    for ex in h["ex"]: print(f"  {label}: {ex}")
print("\nCompare against PRINT_STATUS in public/app.js and update chips if the picture changed.")

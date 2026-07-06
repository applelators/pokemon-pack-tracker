#!/usr/bin/env python3
"""Backfill price_history from TCGCSV's daily archives (phase 2 of trend charts).

TCGCSV publishes one 7z per day (https://tcgcsv.com/archive/tcgplayer/
prices-YYYY-MM-DD.ppmd.7z, ~3MB, PPMd-compressed) containing every group's price
file. This walks each tracked set from its release date to yesterday, pulls the
loose-booster-pack market price per day (box/36 then bundle/6 as fallbacks —
mirroring src/tcgcsv.js fetchSealedRipPrices), and emits INSERT OR IGNORE SQL
for the price_history table. OR IGNORE means existing daily closes (seeds,
refreshes, cron snapshots) always win over backfill.

Usage:
    python3 tools/backfill_price_history.py            # resumable; ~35 min
    npx wrangler d1 execute pokemon-pack-tracker --remote \
        --file build/backfill_price_history.sql

Needs: pip3 install py7zr (PPMd support). Custom sets (fp*) are excluded, same
as every other market-price path.
"""
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import py7zr

API = "https://packs.nabunan.com/api"
TCGCSV = "https://tcgcsv.com/tcgplayer"
ARCHIVE = "https://tcgcsv.com/archive/tcgplayer/prices-{d}.ppmd.7z"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
BASIS = "backfill — TCGplayer daily archive"

BUILD = Path(__file__).resolve().parent.parent / "build"
BUILD.mkdir(exist_ok=True)
PROGRESS = BUILD / "backfill_progress.jsonl"   # one line per completed day (resume)
SQL_OUT = BUILD / "backfill_price_history.sql"

# Known TCGplayer group ids (same as TIER_GROUPS in src/api.js); anything untracked
# there is resolved by name against the groups list.
KNOWN_GROUPS = {
    "sv6": 23473, "sv7": 23537, "sv8": 23651, "sv8pt5": 23821, "sv9": 24073,
    "sv10": 24269, "zsv10pt5": 24325, "rsv10pt5": 24326, "me1": 24380,
    "me2": 24448, "me2pt5": 24541, "me3": 24587, "me4": 24655,
}


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    j = json.load(urllib.request.urlopen(req, timeout=60))
    return j if isinstance(j, list) else j.get("results", j)


def build_map():
    """setId -> {group, release, loose/box/bundle productIds} for tracked sets."""
    sets = [s for s in get_json(f"{API}/sets") if not s["id"].startswith("fp")]
    out = {}
    for s in sets:
        gid = KNOWN_GROUPS.get(s["id"])
        if not gid:
            print(f"  ! {s['id']} has no known groupId — add it to KNOWN_GROUPS", file=sys.stderr)
            continue
        prods = get_json(f"{TCGCSV}/3/{gid}/products")

        def find(rx, notrx=None):
            for p in prods:
                n = p.get("name", "")
                if re.search(rx, n, re.I) and not (notrx and re.search(notrx, n, re.I)):
                    return p["productId"]
            return None

        out[s["id"]] = {
            "group": gid,
            "release": (s.get("release_date") or "").replace("/", "-")[:10],
            "loose": find(r"booster pack", r"sleeved|box|bundle|case|blister"),
            "box": find(r"booster box", r"case|enhanced"),
            "bundle": find(r"booster bundle"),
        }
        time.sleep(0.3)
    return out


def market_for(rows_by_pid, m):
    """Loose max-subtype market, else box/36, else bundle/6 (like repMarket)."""
    def best(pid):
        best_v = 0
        for r in rows_by_pid.get(pid, []):
            v = r.get("marketPrice") or 0
            if v > best_v:
                best_v = v
        return best_v

    v = best(m["loose"])
    if v > 0:
        return round(v, 2)
    v = best(m["box"])
    if v > 0:
        return round(v / 36, 2)
    v = best(m["bundle"])
    if v > 0:
        return round(v / 6, 2)
    return None


def process_day(day, smap):
    """Download one day's archive, return {set_id: market} for released sets."""
    active = {sid: m for sid, m in smap.items() if m["release"] and m["release"] <= day}
    if not active:
        return {}
    url = ARCHIVE.format(d=day)
    try:
        req = urllib.request.Request(url, headers=UA)
        blob = urllib.request.urlopen(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}  # archive missing for this day — skip
        raise
    result = {}
    with py7zr.SevenZipFile(io.BytesIO(blob)) as a:
        want = {f"{day}/3/{m['group']}/prices": sid for sid, m in active.items()}
        names = set(a.getnames())
        targets = [t for t in want if t in names]
        if not targets:
            return {}
        import tempfile, shutil
        tmp = tempfile.mkdtemp()
        try:
            a.extract(path=tmp, targets=targets)
            for t in targets:
                sid = want[t]
                rows = json.load(open(Path(tmp) / t))
                rows = rows if isinstance(rows, list) else rows.get("results", [])
                by_pid = {}
                for r in rows:
                    by_pid.setdefault(r.get("productId"), []).append(r)
                v = market_for(by_pid, active[sid])
                if v:
                    result[sid] = v
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return result


def main():
    print("Resolving set → group/product map…")
    smap = build_map()
    start = min(m["release"] for m in smap.values() if m["release"])
    end = (date.today() - timedelta(days=1)).isoformat()
    print(f"{len(smap)} sets, {start} → {end}")

    done = set()
    if PROGRESS.exists():
        for line in PROGRESS.open():
            try:
                done.add(json.loads(line)["day"])
            except Exception:
                pass
        print(f"resuming: {len(done)} days already done")

    d = date.fromisoformat(start)
    last = date.fromisoformat(end)
    log = PROGRESS.open("a")
    n = 0
    while d <= last:
        day = d.isoformat()
        d += timedelta(days=1)
        if day in done:
            continue
        for attempt in (1, 2, 3):
            try:
                prices = process_day(day, smap)
                break
            except Exception as e:
                if attempt == 3:
                    print(f"{day}: FAILED after 3 tries — {e}", file=sys.stderr)
                    prices = None
                else:
                    time.sleep(5 * attempt)
        if prices is None:
            continue  # not logged as done → retried on next run
        log.write(json.dumps({"day": day, "prices": prices}) + "\n")
        log.flush()
        n += 1
        if n % 50 == 0:
            print(f"…{day} ({n} new days this run)")
        time.sleep(0.4)  # be gentle with the free mirror
    log.close()

    # Emit SQL from the full progress log (500-row batches).
    rows = []
    for line in PROGRESS.open():
        rec = json.loads(line)
        for sid, v in rec["prices"].items():
            rows.append((sid, rec["day"], v))
    rows.sort(key=lambda r: (r[0], r[1]))
    with SQL_OUT.open("w") as f:
        for i in range(0, len(rows), 500):
            chunk = rows[i : i + 500]
            vals = ",\n".join(f"('{s}','{d}',{v},'{BASIS}')" for s, d, v in chunk)
            f.write(f"INSERT OR IGNORE INTO price_history (set_id, day, market, basis) VALUES\n{vals};\n")
    print(f"DONE: {len(rows)} rows → {SQL_OUT}")
    print("Apply with: npx wrangler d1 execute pokemon-pack-tracker --remote --file " + str(SQL_OUT))


if __name__ == "__main__":
    main()

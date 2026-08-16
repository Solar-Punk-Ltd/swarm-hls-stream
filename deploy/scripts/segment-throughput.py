#!/usr/bin/env python3
"""Segment bytes per second a browser arm actually moved, from its own request log.

## ⛔⛔⛔ WHY NOT THE RUN'S `segments` TALLY

`weeb3-native.ts` documents its `SegmentTally` as weeb-3's log panel: a rolling window that reads
about 24 whatever the arm length. Measured 2026-08-16, one arm reported **24** while its request log
carried **671** segment fetches, and a 660-second live arm reported the same 24 against **1,439**.
The tally is useful for the failed count and the mean segment size and for nothing with a denominator.

## Why this is the column that makes two arms comparable

A thread reading is only interesting next to the work that produced it. On 2026-08-16 a live arm and
a recording arm both moved **2.77 Mbps** while their main threads read 0.768 and 0.249, which is what
turned "the gateway-less viewer costs more as the broadcast ages" into a question about live playback
rather than about retrieval volume.

⭐ The median of 30-second buckets, not the mean over the arm. A recording arm opens with a
pre-buffer burst, measured at 7.15 Mbps over its first thirty seconds before settling to 2.76, and a
mean over the whole arm reports neither number.

⚠️ Every segment the page fetches is on weeb-3's own origin, because a service worker serves
`hls/bytes/<reference>` from the node in the tab. That is why the path is matched rather than the
host, and it is why a gateway-less claim still needs the gateway's own counters beside it.

Usage:
  deploy/scripts/segment-throughput.py <run.requests.json>...
"""

import json
import os
import statistics as st
import sys

BUCKET_MS = 30_000
SEGMENT_PATH = "/hls/bytes/"
# ⭐⭐⭐ Counted beside the segments because the difference between a live arm and a recording arm is
# here and nowhere else. Measured 2026-08-16: a live arm re-fetches this ONE url 1,110 times in 661
# seconds and moves 1,195 MB through it, against 261 MB of video. A recording arm fetches it once.
MANIFEST_PATH = "/feeds/"
MIN_BUCKETS = 3


def rows_matching(path, needle):
    with open(path) as handle:
        return [row for row in json.load(handle) if needle in row.get("url", "")]


def segment_rows(path):
    return rows_matching(path, SEGMENT_PATH)


def steady_mbps(path):
    """Median 30-second segment throughput in Mbps, or None when the arm is too short to have one."""
    rows = segment_rows(path)
    if not rows:
        return None
    first = min(row["startedAtMs"] for row in rows)
    buckets = {}
    for row in rows:
        key = int((row["startedAtMs"] - first) // BUCKET_MS)
        buckets[key] = buckets.get(key, 0) + (row.get("bytes") or 0)
    if len(buckets) < MIN_BUCKETS:
        return None
    # The final bucket is a partial one and would drag the median down for no reason.
    full = [buckets[key] for key in sorted(buckets)[:-1]]
    return st.median(full) * 8 / (BUCKET_MS / 1000) / 1e6


def main(argv):
    if not argv:
        print("usage: segment-throughput.py <run.requests.json>...", file=sys.stderr)
        return 2
    print(f"{'run':<30}{'steady Mbps':>12}{'segments':>10}{'seg MB':>9}"
          f"{'manifests':>11}{'per s':>7}{'median MB':>10}{'man MB':>9}{'man/seg':>9}")
    for path in argv:
        rows = segment_rows(path)
        if not rows:
            print(f"{os.path.basename(path)[:30]:<30}{'no segment fetches':>39}")
            continue
        seg_total = sum(r.get("bytes") or 0 for r in rows)
        manifests = rows_matching(path, MANIFEST_PATH)
        man_total = sum(r.get("bytes") or 0 for r in manifests)
        man_span = ((max(r["startedAtMs"] for r in manifests) - min(r["startedAtMs"] for r in manifests)) / 1000
                    if len(manifests) > 1 else 0.0)
        mbps = steady_mbps(path)
        print(f"{os.path.basename(path)[:30]:<30}"
              f"{('-' if mbps is None else f'{mbps:.2f}'):>12}{len(rows):>10}{seg_total / 1e6:>9.1f}"
              f"{len(manifests):>11}"
              f"{(len(manifests) / man_span if man_span else 0):>7.2f}"
              f"{(st.median((r.get('bytes') or 0) for r in manifests) / 1e6 if manifests else 0):>10.3f}"
              f"{man_total / 1e6:>9.1f}"
              f"{(man_total / seg_total if seg_total else 0):>8.2f}x")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

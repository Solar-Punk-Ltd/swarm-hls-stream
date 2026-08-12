#!/usr/bin/env python3
"""What the bee nodes say they did, differenced across a measurement window.

Every sitting in this repo has been scored on what the harness saw from outside. The nodes keep their
own account of the same events and nothing had read it during a run.

⭐⭐⭐ Two findings from 2026-08-12 were derived indirectly and are directly instrumented here.
`gop-floor-replicate` timed 404s from outside and concluded a segment's reference beats its bytes by
about 100ms. `bee_pusher_sync_time_sum/count` is that quantity, and `to_push - synced` is the live
backlog. `what-latency-is-made-of` decomposed a 497ms fetch hop from segment timings, and
`bee_retrieval_request_duration_time`, `request_attempts` and `request_failure_count` are its
internals.

⛔ Everything useful here is a **monotonic lifetime total**, so one reading says nothing about a
30-minute sitting. Two readings differenced say exactly what happened between them. The uploader's
lifetime mean push-sync is 13.4ms over 2.25 million chunks, and quoting that as a run's figure is the
mistake this file exists to prevent.

A separate module from the shell that collects it, because inline Python inside shell quoting cannot
carry an f-string containing quotes, and the collection needs the host's network while the arithmetic
does not.
"""
from __future__ import annotations

import json
import sys

DASH = "—"


def parse_prometheus(text: str) -> dict[str, float]:
    """Metric name (with labels) to value, skipping comments and anything non-numeric."""
    out: dict[str, float] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, value = line.rpartition(" ")
        try:
            out[name.strip()] = float(value)
        except ValueError:
            continue
    return out


def build_snapshot(label: str, at_ms: int, host_load: str, raw: dict[str, str]) -> dict:
    def loads(text: str, fallback):
        try:
            return json.loads(text)
        except Exception:
            return fallback

    return {
        "label": label,
        "atMs": at_ms,
        "hostLoad": host_load,
        "uploader": parse_prometheus(raw.get("uploaderMetrics", "")),
        "gateway": parse_prometheus(raw.get("gatewayMetrics", "")),
        "stamps": loads(raw.get("stamps", ""), {}),
        "uploaderHealth": loads(raw.get("health", ""), {}),
        "chequebook": {
            "uploader": loads(raw.get("chequebookUploader", ""), {}),
            "gateway": loads(raw.get("chequebookGateway", ""), {}),
        },
    }


def _delta(before: dict, after: dict, side: str, name: str) -> float:
    return after.get(side, {}).get(name, 0.0) - before.get(side, {}).get(name, 0.0)


def _mean_ms(before: dict, after: dict, side: str, stem: str) -> float | None:
    """A sum/count pair differenced: the mean over THIS window, never over the node's life."""
    d_sum = _delta(before, after, side, stem + "_sum")
    d_count = _delta(before, after, side, stem + "_count")
    return (d_sum / d_count * 1000.0) if d_count > 0 else None


def _batches(snapshot: dict) -> dict[str, tuple[int, int, float]]:
    out = {}
    for batch in snapshot.get("stamps", {}).get("stamps", []):
        buckets = 2 ** (batch["depth"] - batch["bucketDepth"])
        out[batch["batchID"]] = (batch["utilization"], buckets, batch["batchTTL"] / 86400.0)
    return out


def render_diff(before: dict, after: dict) -> list[str]:
    window_s = (after["atMs"] - before["atMs"]) / 1000.0
    lines = [
        f"window {window_s:.0f}s   host load {before['hostLoad']} -> {after['hostLoad']}",
        "",
        "UPLOADER, the write path",
    ]

    def row(label: str, value) -> None:
        lines.append(f"  {label:<42} {DASH if value is None else value}")

    pushed = _delta(before, after, "uploader", "bee_pusher_total_synced")
    sync_ms = _mean_ms(before, after, "uploader", "bee_pusher_sync_time")
    peer_ms = _mean_ms(before, after, "uploader", "bee_pushsync_push_peer_time")
    errors = _delta(before, after, "uploader", "bee_pusher_total_errors")

    row("chunks push-synced", f"{pushed:.0f}")
    row("mean push-sync time", None if sync_ms is None else f"{sync_ms:.1f} ms")
    row("mean per-peer push", None if peer_ms is None else f"{peer_ms:.1f} ms")
    row("push errors, retried", f"{errors:.0f}" + (f"   {100 * errors / pushed:.1f}% of pushes" if pushed else ""))

    def backlog(snapshot: dict) -> float:
        side = snapshot.get("uploader", {})
        return side.get("bee_pusher_total_to_push", 0.0) - side.get("bee_pusher_total_synced", 0.0)

    row("unsynced backlog", f"{backlog(before):.0f} -> {backlog(after):.0f}")
    row("invalid stamps", f"{_delta(before, after, 'uploader', 'bee_pushsync_invalid_stamps'):.0f}")

    lines += ["", "GATEWAY, the read path"]
    requests = _delta(before, after, "gateway", "bee_retrieval_request_count")
    failures = _delta(before, after, "gateway", "bee_retrieval_request_failure_count")
    retrieve_ms = _mean_ms(before, after, "gateway", "bee_retrieval_request_duration_time")
    attempts = _delta(before, after, "gateway", "bee_retrieval_request_attempts_sum")
    attempts_n = _delta(before, after, "gateway", "bee_retrieval_request_attempts_count")

    row("retrieval requests", f"{requests:.0f}")
    row("mean retrieval time", None if retrieve_ms is None else f"{retrieve_ms:.1f} ms")
    row("peers asked per request", f"{attempts / attempts_n:.2f}" if attempts_n > 0 else None)
    row("failed outright", f"{failures:.0f}" + (f"   {100 * failures / requests:.1f}%" if requests else ""))
    row("invalid chunks retrieved", f"{_delta(before, after, 'gateway', 'bee_retrieval_invalid_chunk_retrieved'):.0f}")

    lines += ["", "BUDGET AND CAPACITY"]
    for who in ("uploader", "gateway"):
        start = before["chequebook"].get(who, {}).get("availableBalance")
        end = after["chequebook"].get(who, {}).get("availableBalance")
        if start is None or end is None:
            continue
        spent = (int(start) - int(end)) / 1e16
        rate = spent / (window_s / 3600.0) if window_s > 0 else 0.0
        row(f"{who} spent", f"{spent:.4f} BZZ   {rate:.2f} BZZ per broadcast hour")

    seen_before, seen_after = _batches(before), _batches(after)
    for batch_id, (used, buckets, _) in seen_after.items():
        was = seen_before.get(batch_id, (used, buckets, 0.0))[0]
        ttl = seen_after[batch_id][2]
        row(f"batch {batch_id[:8]}", f"{was} -> {used} of {buckets} ({100 * used / buckets:.0f}%), TTL {ttl:.1f}d")

    health_before = before.get("uploaderHealth", {})
    health_after = after.get("uploaderHealth", {})
    for key in ("segmentsSkipped", "segmentsNeverNamed", "maxConsecutiveSegmentFailures"):
        if key in health_after:
            row(f"uploader {key}", f"{health_before.get(key, DASH)} -> {health_after[key]}")

    return lines


def breached_floors(snapshot: dict, reserve_plur: int, max_utilization_pct: float) -> list[str]:
    """The reasons this snapshot says a sitting should stop, or an empty list to carry on.

    ⛔ The point of reading these DURING a run rather than after it. A single continuous arm has one
    funding check, at minute zero, so a four-hour broadcast that runs its chequebook dry at hour three
    spends its last hour measuring what a starved node does and files it as a result. A node at zero
    is refused service by its peers, which looks like the network being slow.
    """
    reasons = []
    for who in ("uploader", "gateway"):
        available = snapshot.get("chequebook", {}).get(who, {}).get("availableBalance")
        if available is None:
            reasons.append(f"the {who} chequebook stopped answering, so the budget is unknown")
        elif int(available) < reserve_plur:
            reasons.append(f"{who} available {int(available) / 1e16:.4f} BZZ is under the {reserve_plur / 1e16:.2f} reserve")

    for batch_id, (used, buckets, ttl_days) in _batches(snapshot).items():
        pct = 100.0 * used / buckets
        if pct >= max_utilization_pct:
            reasons.append(f"batch {batch_id[:8]} is {pct:.0f}% full, at the {max_utilization_pct:.0f}% stop line")
    return reasons


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "diff":
        before = json.load(open(argv[2]))
        after = json.load(open(argv[3]))
        print("\n".join(render_diff(before, after)))
        return 0
    if len(argv) >= 2 and argv[1] == "build":
        payload = json.load(sys.stdin)
        print(json.dumps(build_snapshot(payload["label"], payload["atMs"], payload["hostLoad"], payload), indent=2))
        return 0
    if len(argv) >= 5 and argv[1] == "floors":
        snapshot = json.load(open(argv[2]))
        reasons = breached_floors(snapshot, int(argv[3]), float(argv[4]))
        for reason in reasons:
            print(reason)
        return 1 if reasons else 0
    print(
        "usage: node_metrics.py build < payload.json | diff <before.json> <after.json>"
        " | floors <snapshot.json> <reserve_plur> <max_utilization_pct>",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

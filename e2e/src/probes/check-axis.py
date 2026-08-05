"""Did the run actually produce the configuration it was asked for?

A sweep varies an axis and reports rows against it. If the axis never moved, every row is a
measurement of the same thing wearing different labels, and nothing downstream can tell. That
happened on 2026-08-05: twelve runs swept a GOP from 0.5s to 2.0s while SRS cut every one of them at
about 0.43s, because `hls_aof_ratio` force-closes a segment at `hls_fragment * ratio` whether a
keyframe has arrived or not. The rows looked like results.

So a run is checked against its own request before it is allowed to count. Both quantities were
already in the report and neither was being read.

The second check has the same shape and was paid for the same way. On 2026-08-05 the bench's own
collection loop turned out to take about 260ms per iteration while advancing exactly one feed slot per
iteration, so it walks at most about 3.8 slots per second. A 0.25s GOP writes four. Those rows
reported 8.71s and 2.58s of latency and were measuring the instrument falling behind, and I proposed
three separate mechanisms for the artifact before finding it. A follower that advances one slot per
read has a catch-up rate equal to its poll rate, so once behind it never recovers and the deficit
grows for the rest of the run.

Usage:  python3 check-axis.py <report.json> <requested-gop-seconds> <fps>
Exits 0 when the run matches what it asked for and the reader kept pace, 1 otherwise, and prints one
line either way.
"""

import json
import statistics as st
import sys

# The segment is cut on a keyframe, so it lands on a GOP boundary rather than exactly on the request,
# and the span is measured first-frame to last-frame which is one frame interval short. A tenth is
# wide enough for both and far tighter than the 4x error it exists to catch.
SEGMENT_TOLERANCE = 0.10
# Packet count against what the frame rate implies for the media actually carried. A segment cut
# mid-GOP holds no keyframe and shows up here as well as in the discard count.
PACKET_TOLERANCE = 0.10
# Reported rather than fatal, and the distinction is the point. A malformed segment shows up in the
# two checks above, which are the ones that decide whether the axis moved. Segments that are well
# formed and still unreadable are a separate defect in the instrument's own PTS anchoring, and failing
# the run for it would discard a broadcast over a known bug. See the 33-bit wrap note in `wallclock.ts`.
NOTEWORTHY_DISCARDED_SHARE = 0.05
# How far short of the write rate the reader may fall before the run is measuring the instrument.
# Five percent covers the run's own boundaries, where the first and last segments are partly outside
# the window, while catching the 7 to 10% shortfall that made the 0.25s rows unreadable.
READER_PACE_TOLERANCE = 0.05


def reader_pace(run: dict, requested_gop_s: float) -> tuple[float, float, float] | None:
    """Slots per second the reader achieved, what the GOP demands, and its median loop time.

    None where the report predates `resolvedIndex` or carries too few polls to measure a rate.
    """
    polls = run.get("feedPolls") or []
    resolved = [p for p in polls if p.get("resolvedIndex") is not None]
    if len(resolved) < 2 or len(polls) < 2:
        return None

    span_s = (resolved[-1]["atMs"] - resolved[0]["atMs"]) / 1_000
    if span_s <= 0:
        return None

    achieved = (resolved[-1]["resolvedIndex"] - resolved[0]["resolvedIndex"]) / span_s
    gaps = sorted(polls[i + 1]["atMs"] - polls[i]["atMs"] for i in range(len(polls) - 1))
    return achieved, 1 / requested_gop_s, st.median(gaps)


def main() -> int:
    report_path, requested_gop_s, fps = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    run = json.load(open(report_path))
    samples = run["samples"]
    if not samples:
        print(f"AXIS FAIL: {report_path} carries no samples at all")
        return 1

    spans = [s["split"]["instants"]["segmentDurationS"] for s in samples]
    segment_s = st.median(spans)
    packets = st.median([s["videoPacketCount"] for s in samples])
    expected_packets = segment_s * fps
    discarded_share = len(run["discarded"]) / (len(samples) + len(run["discarded"]))

    problems = []
    if abs(segment_s - requested_gop_s) > SEGMENT_TOLERANCE * requested_gop_s:
        problems.append(
            f"asked for a {requested_gop_s}s GOP and measured {segment_s:.3f}s segments"
        )
    if abs(packets - expected_packets) > PACKET_TOLERANCE * expected_packets:
        problems.append(
            f"{packets:.0f} packets per segment against the {expected_packets:.0f} that "
            f"{fps:g}fps implies for {segment_s:.3f}s, so segments are being cut mid-GOP"
        )
    if problems:
        print(f"AXIS FAIL: {'; '.join(problems)}")
        return 1

    # Separate from the axis checks and separately fatal. The axis moved here, the encoder did what it
    # was asked, and the run is still unusable because the reader could not follow it. Reported with
    # its own verdict so a sweep's log says which of the two happened.
    pace = reader_pace(run, requested_gop_s)
    if pace is not None:
        achieved, needed, loop_ms = pace
        if achieved < needed * (1 - READER_PACE_TOLERANCE):
            print(
                f"READER BEHIND: the reader walked {achieved:.2f} feed slots per second against the "
                f"{needed:.2f} a {requested_gop_s}s GOP writes, and its loop took {loop_ms:.0f}ms per "
                f"iteration against a {requested_gop_s * 1_000:.0f}ms budget. It advances one slot per "
                "poll, so it never catches up and this run measures the instrument, not the deployment"
            )
            return 1

    note = " UNREADABLE-HIGH" if discarded_share > NOTEWORTHY_DISCARDED_SHARE else ""
    pace_note = "" if pace is None else f", reader {pace[0]:.2f}/{pace[1]:.2f} slots per second"
    print(
        f"axis ok{note}: {segment_s:.3f}s segments for a {requested_gop_s}s GOP, "
        f"{packets:.0f} packets, {discarded_share:.1%} unreadable{pace_note}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

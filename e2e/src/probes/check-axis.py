"""Did the run actually produce the configuration it was asked for?

A sweep varies an axis and reports rows against it. If the axis never moved, every row is a
measurement of the same thing wearing different labels, and nothing downstream can tell. That
happened on 2026-08-05: twelve runs swept a GOP from 0.5s to 2.0s while SRS cut every one of them at
about 0.43s, because `hls_aof_ratio` force-closes a segment at `hls_fragment * ratio` whether a
keyframe has arrived or not. The rows looked like results.

So a run is checked against its own request before it is allowed to count. Both quantities were
already in the report and neither was being read.

Usage:  python3 check-axis.py <report.json> <requested-gop-seconds> <fps>
Exits 0 when the run matches what it asked for, 1 otherwise, and prints one line either way.
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

    note = " UNREADABLE-HIGH" if discarded_share > NOTEWORTHY_DISCARDED_SHARE else ""
    print(
        f"axis ok{note}: {segment_s:.3f}s segments for a {requested_gop_s}s GOP, "
        f"{packets:.0f} packets, {discarded_share:.1%} unreadable"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

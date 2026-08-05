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
iteration, so it walked at most about 3.8 slots per second. A 0.25s GOP writes four. Those rows
reported 8.71s and 2.58s of latency and were measuring the instrument falling behind, and I proposed
three separate mechanisms for the artifact before finding it. The follower now walks to the live edge
in one read, so the deficit no longer compounds, and this check is what says whether that held.

**It is checked against the rate the publisher achieved, not the rate it was asked for**, and the
difference is not pedantic. When the encoder under-delivers, a reader that tracks it perfectly is
still slower than the request, and comparing against the request reports the reader for the encoder's
shortfall. That is exactly what happened on the first run of the sweep that fixed the follower: the
encoder produced 0.540s segments for a 0.5s request, so the publisher wrote 1.85 slots per second, the
reader walked 1.86, and the run was rejected as READER BEHIND. The segment-length check above is what
catches an encoder that missed its request, and it runs first, so by the time this one runs the
achieved rate is already known to be close to the requested one.

The frame-rate check was the same arithmetic as the packet check before it and reported the wrong
cause. `packets < span * fps` and `delivered fps < fps` are one inequality rearranged, and the verdict
said "segments are being cut mid-GOP", which sends a reader to the encoder. It is not what happens.
Two of the six runs on 2026-08-05 held **exactly** the frames one requested GOP holds, 8 for 0.25s and
15 for 0.5s, and spanned 0.666s and 0.633s, so the GOP was intact and the media time was stretched.

Reproduced with no engine, no Swarm and no postage in `docs/bench/publisher-backpressure.md`: the
publish recipe stamps timestamps at demux and paces inside the filter graph, so a consumer slower than
the stream's own bitrate blocks the muxer, the demuxer stops pulling, and the wall clock keeps
running. Feeding that encode to a pipe read at 150kB/s delivered **12.2fps** against a run that
measured 12.0, and nothing warned. So the discriminator is whether the segment holds a *whole* GOP:
it does under a throttle, and it does not when the segmenter cut mid-GOP.

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
# Packet count against what one requested GOP holds. This is the discriminator between the two ways a
# segment can carry fewer frames than its own span implies, and they have opposite causes: a segment
# cut mid-GOP holds a fraction of a GOP, while a throttled publisher holds a whole one and took longer
# to produce it.
PACKET_TOLERANCE = 0.10
# How far the delivered frame rate may fall short of the request. Wider than it looks: the span
# credits the final frame with the median gap, so `packets / span` is the delivered rate exactly
# rather than short by a frame, and 10% is four times the largest shortfall a passing run has shown.
FRAME_RATE_TOLERANCE = 0.10
# Reported rather than fatal, and the distinction is the point. A malformed segment shows up in the
# two checks above, which are the ones that decide whether the axis moved. Segments that are well
# formed and still unreadable are a separate defect in the instrument's own PTS anchoring, and failing
# the run for it would discard a broadcast over a known bug. See the 33-bit wrap note in `wallclock.ts`.
NOTEWORTHY_DISCARDED_SHARE = 0.05
# How far short of the write rate the reader may fall before the run is measuring the instrument.
# Five percent covers the run's own boundaries, where the first and last segments are partly outside
# the window, while catching the 7 to 10% shortfall that made the 0.25s rows unreadable.
READER_PACE_TOLERANCE = 0.05
# Mirrors `MAX_WALK_PER_READ` in `e2e/src/bench/gateway.ts`, for the verdict text only. A reader
# sitting at the bound every poll is one publisher speed-up away from falling behind, which is worth
# reading off a passing run rather than discovering from the next failing one.
MAX_WALK_PER_READ = 32


def reader_pace(run: dict, achieved_segment_s: float) -> tuple[float, float, float, float] | None:
    """Slots per second the reader achieved, what the publisher wrote, its loop time, and walk depth.

    The write rate comes from the segment length the encoder actually produced, because that is what
    the reader had to follow. Using the requested length instead reports the reader whenever the
    encoder misses, which is a different failure with its own verdict above.

    None where the report predates `resolvedIndex` or carries too few polls to measure a rate.
    """
    polls = run.get("feedPolls") or []
    resolved = [p for p in polls if p.get("resolvedIndex") is not None]
    if len(resolved) < 2 or len(polls) < 2:
        return None

    span_s = (resolved[-1]["atMs"] - resolved[0]["atMs"]) / 1_000
    if span_s <= 0 or achieved_segment_s <= 0:
        return None

    achieved = (resolved[-1]["resolvedIndex"] - resolved[0]["resolvedIndex"]) / span_s
    gaps = sorted(polls[i + 1]["atMs"] - polls[i]["atMs"] for i in range(len(polls) - 1))
    steps = [
        resolved[i + 1]["resolvedIndex"] - resolved[i]["resolvedIndex"] for i in range(len(resolved) - 1)
    ]
    return achieved, 1 / achieved_segment_s, st.median(gaps), st.median(steps)


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
    discarded_share = len(run["discarded"]) / (len(samples) + len(run["discarded"]))

    delivered_fps = packets / segment_s if segment_s > 0 else 0
    gop_packets = requested_gop_s * fps
    holds_a_whole_gop = abs(packets - gop_packets) <= PACKET_TOLERANCE * gop_packets

    problems = []
    if delivered_fps < fps * (1 - FRAME_RATE_TOLERANCE):
        if holds_a_whole_gop:
            problems.append(
                f"the publisher delivered {delivered_fps:.1f}fps against the {fps:g} it was asked for, "
                f"so a whole GOP of {packets:.0f} frames spans {segment_s:.3f}s instead of "
                f"{requested_gop_s}s. The GOP is intact and the media time is stretched, which is a "
                "consumer slower than the stream's own bitrate rather than an encoder that missed"
            )
        else:
            problems.append(
                f"{packets:.0f} packets per segment against the {gop_packets:.0f} a {requested_gop_s}s "
                f"GOP holds at {fps:g}fps, and only {delivered_fps:.1f}fps delivered, so segments are "
                "being cut mid-GOP"
            )
    elif abs(segment_s - requested_gop_s) > SEGMENT_TOLERANCE * requested_gop_s:
        problems.append(
            f"asked for a {requested_gop_s}s GOP and measured {segment_s:.3f}s segments at the full "
            f"{delivered_fps:.1f}fps, so the segmenter is cutting somewhere other than the GOP"
        )
    if problems:
        print(f"AXIS FAIL: {'; '.join(problems)}")
        return 1

    # Separate from the axis checks and separately fatal. The axis moved here, the encoder did what it
    # was asked, and the run is still unusable because the reader could not follow it. Reported with
    # its own verdict so a sweep's log says which of the two happened.
    pace = reader_pace(run, segment_s)
    if pace is not None:
        achieved, written, loop_ms, walk = pace
        if achieved < written * (1 - READER_PACE_TOLERANCE):
            print(
                f"READER BEHIND: the reader walked {achieved:.2f} feed slots per second against the "
                f"{written:.2f} the publisher wrote at its achieved {segment_s:.3f}s segments, taking "
                f"{loop_ms:.0f}ms per poll and {walk:.0f} slots a poll against a {MAX_WALK_PER_READ} "
                "bound. A reader that cannot reach the edge samples stale manifests, so this run "
                "measures the instrument, not the deployment"
            )
            return 1

    note = " UNREADABLE-HIGH" if discarded_share > NOTEWORTHY_DISCARDED_SHARE else ""
    pace_note = (
        ""
        if pace is None
        else f", reader {pace[0]:.2f}/{pace[1]:.2f} slots per second at {pace[3]:.0f} slots a poll"
    )
    print(
        f"axis ok{note}: {segment_s:.3f}s segments for a {requested_gop_s}s GOP, "
        f"{packets:.0f} packets at {delivered_fps:.1f}/{fps:g}fps, "
        f"{discarded_share:.1%} unreadable{pace_note}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

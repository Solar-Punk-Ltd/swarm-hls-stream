#!/usr/bin/env python3
"""Decide whether a running SRS stage publishes the segment length a driver asked for.

The judgement half of `stage-fingerprint.sh`, which is the half worth testing. The shell beside it
does one thing this cannot: reach into a container for the two files read here.

## Why this is a file rather than `python3 -c` inside the shell script

`stamp-guard.sh` embeds its python in a single-quoted shell string, and that is fine there. The first
version of this did the same and **exited 0 without running, printing nothing at all**, because a
comment in the python said `THE DRIVER'S GOP`. The apostrophe closed the shell string, the rest of the
program became shell tokens, and a gate whose entire purpose is refusing silently approved everything.
A gate that cannot fail loudly is worse than no gate, so the quoting class is removed rather than
avoided.

## What it compares, and against what

⛔⛔⛔ **The driver's GOP is the reference. The stage's own prediction is the suspect.** SRS publishes
`segment = ceil(hls_fragment / GOP) * GOP`. Comparing the observed median against that agrees with
itself by construction: a neighbour who sets `hls_fragment 2.0` gets 2.0s segments, the prediction
says 2.0s, and the check passes the exact scenario it exists to catch. `stage_forces` below is that
quantity and it is never the yardstick.

Three faults, which have different causes and different fixes:

- **A, the stage overrides the driver.** `hls_fragment` longer than the GOP asked for, so the round-up
  lands above it and no GOP this side chooses brings it back down.
- **B, the stage is not doing what its own config says.** A starved encoder missing its keyframe
  cadence lands here.
- **C, the request leaves the range SRS can serve.** `[fragment, fragment * aof_ratio]`. This project
  has walked out of that range twice by its own hand.

Usage:
  stage-fingerprint.py --gop 0.5 --conf <srs.conf> --playlist <index.m3u8> [--source <label>]
"""

import argparse
import math
import re
import sys

# Enough segments that one short opening segment cannot decide the median. A 0.5s GOP publishes this
# many inside four seconds, so waiting for them costs nothing.
DEFAULT_MIN_SEGMENTS = 6

# How far the observed median may sit from what the config predicts, as a fraction. SRS force-cuts on
# a keyframe, so a published segment lands on a GOP boundary rather than exactly on the arithmetic. A
# tenth admits that without admitting a whole GOP step, which is the smallest error worth catching.
DEFAULT_TOLERANCE = 0.10

EXIT_MATCHES = 0
EXIT_REFUSED = 1
EXIT_USAGE = 2

# ⭐ Separated from {@link EXIT_REFUSED} so a caller can tell "ask me again in a moment" from "this
# stage is wrong". A broadcast that has just started has published one or two segments, and a driver
# calling this the instant the uploader sees a stream would otherwise refuse every healthy sitting.
# A caller that ignores the distinction and treats anything non-zero as a refusal is still correct,
# only impatient, which is the safe direction for the mistake to fall.
EXIT_NOT_READY = 3


def directive(conf: str, name: str) -> float | None:
    """The numeric value of an SRS config directive, or None when it is absent."""
    found = re.search(rf"^\s*{name}\s+([0-9.]+)\s*;", conf, re.M)
    return float(found.group(1)) if found else None


def extinf_durations(playlist: str) -> list[float]:
    """Every raw `#EXTINF` in publication order.

    ⛔ Raw, never `#EXT-X-TARGETDURATION`, which is a ceiling over the longest segment and reads the
    same for a 0.5s and a 1.0s profile.
    """
    return [float(d) for d in re.findall(r"#EXTINF:([0-9.]+)", playlist)]


def median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2.0


def refusals(fragment: float, aof_ratio: float, gop: float, observed: float, tolerance: float) -> list[str]:
    """Every reason this stage cannot carry a sitting labelled `gop`, in the order they are checked."""
    stage_forces = math.ceil(fragment / gop) * gop
    low, high = fragment, fragment * aof_ratio
    reasons = []

    if abs(stage_forces - gop) > 1e-9:
        reasons.append(
            f"hls_fragment {fragment:g} forces {stage_forces:.3f}s segments, so a {gop:g}s GOP cannot "
            f"be published on this stage at all and every artefact would still be labelled {gop:g}s"
        )

    drift = abs(observed - stage_forces)
    if stage_forces > 0 and drift / stage_forces > tolerance:
        reasons.append(
            f"the stage is publishing {observed:.3f}s against the {stage_forces:.3f}s its own config "
            f"predicts, {100.0 * drift / stage_forces:.0f}% off, so something upstream of SRS is not "
            f"delivering the keyframe cadence it was asked for"
        )

    if not low - 1e-9 <= stage_forces <= high + 1e-9:
        reasons.append(
            f"{stage_forces:.3f}s is outside the [{low:g}, {high:g}] this stage can publish, so SRS "
            f"force-cuts somewhere inside that range instead"
        )

    return reasons


def read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--gop", type=float, required=True)
    parser.add_argument("--conf", required=True)
    parser.add_argument("--playlist", required=True)
    parser.add_argument("--source", default="the stage")
    parser.add_argument("--min-segments", type=int, default=DEFAULT_MIN_SEGMENTS)
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    args = parser.parse_args()

    if args.gop <= 0:
        print(f"stage-fingerprint: --gop must be positive, got {args.gop}", file=sys.stderr)
        return EXIT_USAGE

    conf = read(args.conf)
    if not conf:
        print(f"stage-fingerprint: REFUSING, the SRS config at {args.conf} is empty or unreadable.")
        print("  An unreadable stage is not a matching stage.")
        return EXIT_REFUSED

    fragment = directive(conf, "hls_fragment")
    aof_ratio = directive(conf, "hls_aof_ratio")
    if fragment is None or aof_ratio is None:
        absent = " and ".join(
            name for name, value in (("hls_fragment", fragment), ("hls_aof_ratio", aof_ratio)) if value is None
        )
        print(f"stage-fingerprint: REFUSING, {absent} is not in the config on {args.source}.")
        print("  The prediction cannot be formed, so nothing here can say the stage matches.")
        return EXIT_REFUSED
    if fragment <= 0:
        print(f"stage-fingerprint: REFUSING, hls_fragment on {args.source} is {fragment:g}.")
        return EXIT_REFUSED

    playlist = read(args.playlist)
    durations = extinf_durations(playlist)
    if len(durations) < args.min_segments:
        print(
            f"stage-fingerprint: NOT READY, the playlist on {args.source} holds {len(durations)} "
            f"segments and this needs {args.min_segments}."
        )
        print("  A median over fewer is decided by the opening segment, which is short by construction.")
        return EXIT_NOT_READY

    observed = median(durations)
    stage_forces = math.ceil(fragment / args.gop) * args.gop

    print(
        f"stage-fingerprint: {args.source} hls_fragment {fragment:g} aof_ratio {aof_ratio:g}, "
        f"driver asked for a {args.gop:g}s GOP"
    )
    print(
        f"  this stage publishes ceil({fragment:g}/{args.gop:g})*{args.gop:g} = {stage_forces:.3f}s, "
        f"observed median {observed:.3f}s over {len(durations)} segments"
    )

    reasons = refusals(fragment, aof_ratio, args.gop, observed, args.tolerance)
    if not reasons:
        print("  the stage matches what the driver asked for")
        return EXIT_MATCHES

    print("")
    print("stage-fingerprint: REFUSING TO START. " + "; ".join(reasons) + ".")
    print("")
    print("  The knob is the encoder GOP, not hls_fragment. hls_fragment sets the FLOOR and")
    print("  hls_aof_ratio the ceiling, and the GOP decides where inside that range a segment lands.")
    return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())

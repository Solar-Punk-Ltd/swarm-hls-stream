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


class AmbiguousDirective(Exception):
    """Raised when one config gives a directive more than one value. See {@link directive}."""

    def __init__(self, name: str, values: list[float]) -> None:
        super().__init__(name)
        self.name = name
        self.values = values


def directive(conf: str, name: str) -> float | None:
    """The numeric value of an SRS config directive, or None when it is absent.

    ⛔⛔⛔ This used to be one `re.search`, which returns the FIRST match, and that was correct only
    for as long as `srs.conf` held exactly one vhost. `ABR_ENABLED=true` makes `entrypoint.sh`
    generate a second one carrying the transcoded rungs, each vhost with its own `hls` block, so the
    first match stopped meaning "the stage's fragment" and started meaning "whichever vhost happens
    to be written first in the file".

    Refuses on disagreement rather than picking a winner. Which vhost a sitting is publishing through
    is not something this file can see, so a rule for choosing would be a guess, and a gate that
    guesses is the failure mode rather than the fix. Identical values are not a disagreement, which is
    what the generated config actually produces today: both vhosts interpolate `${HLS_FRAGMENT}`.
    """
    values = [float(v) for v in re.findall(rf"^\s*{name}\s+([0-9.]+)\s*;", conf, re.M)]
    if not values:
        return None
    if len(set(values)) > 1:
        raise AmbiguousDirective(name, values)
    return values[0]


def directive_count(conf: str, name: str) -> int:
    """How many times a directive is declared, which is how many vhosts carry an `hls` block.

    A ladder makes `entrypoint.sh` generate a second vhost with its own `hls_fragment`, so a count
    above one means a ladder is configured even when the two values agree and {@link directive}
    returns a single number without raising. It is the one signal here that a ladder exists, because
    the wrapper only ever fetches as many playlists as the driver asked for.
    """
    return len(re.findall(rf"^\s*{name}\s+[0-9.]+\s*;", conf, re.M))


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


def label(path: str) -> str:
    """A playlist's file name, which is what names the rung once a ladder publishes four of them."""
    return path.rsplit("/", 1)[-1] or path


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
    # Repeatable, because a ladder publishes one playlist per rung plus the source. Judging the
    # newest single one left four rungs unchecked, so a sitting could run on a profile nothing had
    # looked at, which is the same shape of hole as reading `hls_fragment` off one vhost.
    parser.add_argument("--playlist", required=True, action="append")
    parser.add_argument("--source", default="the stage")
    # How many rungs the driver configured, so this can tell a ladder judged whole from one judged a
    # single rung. Defaults to 1, the single-rendition case this served before ABR existed.
    parser.add_argument("--rungs", type=int, default=1)
    parser.add_argument("--min-segments", type=int, default=DEFAULT_MIN_SEGMENTS)
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    args = parser.parse_args()

    if args.gop <= 0:
        print(f"stage-fingerprint: --gop must be positive, got {args.gop}", file=sys.stderr)
        return EXIT_USAGE

    if args.rungs < 1:
        print(f"stage-fingerprint: --rungs must be positive, got {args.rungs}", file=sys.stderr)
        return EXIT_USAGE

    conf = read(args.conf)
    if not conf:
        print(f"stage-fingerprint: REFUSING, the SRS config at {args.conf} is empty or unreadable.")
        print("  An unreadable stage is not a matching stage.")
        return EXIT_REFUSED

    try:
        fragment = directive(conf, "hls_fragment")
        aof_ratio = directive(conf, "hls_aof_ratio")
    except AmbiguousDirective as ambiguous:
        values = ", ".join(f"{v:g}" for v in sorted(set(ambiguous.values)))
        print(f"stage-fingerprint: REFUSING, {ambiguous.name} on {args.source} has more than one value ({values}).")
        print("  The config carries a second vhost, which is what ABR_ENABLED generates, and this")
        print("  cannot see which one the sitting publishes through. One fingerprint cannot describe")
        print("  two profiles, and picking whichever came first in the file is how a sitting runs on")
        print("  a stage nobody checked.")
        return EXIT_REFUSED
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

    # A ladder generates a second vhost with its own hls_fragment, so more than one declaration means
    # the stage is publishing a ladder. Judging one rung of it is the same hole as reading hls_fragment
    # off one vhost: the sitting runs on rungs nobody looked at. The wrapper only fetches as many
    # playlists as --rungs, so this is the one place a ladder-with-one-rung can be caught at all.
    vhosts = directive_count(conf, "hls_fragment")
    if vhosts > 1 and args.rungs <= 1:
        print(f"stage-fingerprint: REFUSING, {args.source} carries {vhosts} vhosts, so it is a ladder, but --rungs is {args.rungs}.")
        print("  A ladder publishes one playlist per rung and judging a single one leaves the rest")
        print("  unchecked. Pass --rungs for the ladder the driver configured.")
        return EXIT_REFUSED

    # Fewer playlists than the driver asked for is not yet a verdict: rungs come up seconds apart,
    # and the 2026-08-28 paired sitting was refused 8s after publish start with 3 of 4 live, minutes
    # after the same gate passed the same stage with all four. Whether a missing rung is "not yet" or
    # "never" is the caller's retry deadline's call, the same contract as too-few segments below, and
    # the deadline expiring is what turns this into the final refusal.
    if len(args.playlist) < args.rungs:
        print(
            f"stage-fingerprint: NOT READY, asked to judge {args.rungs} rungs but found "
            f"{len(args.playlist)} playlist(s) on {args.source}."
        )
        print("  A rung that has not published its first playlist yet cannot be judged, and one that")
        print("  never publishes is refused by the caller's deadline expiring on this answer.")
        return EXIT_NOT_READY

    stage_forces = math.ceil(fragment / args.gop) * args.gop
    print(
        f"stage-fingerprint: {args.source} hls_fragment {fragment:g} aof_ratio {aof_ratio:g}, "
        f"driver asked for a {args.gop:g}s GOP"
    )
    print(f"  this stage publishes ceil({fragment:g}/{args.gop:g})*{args.gop:g} = {stage_forces:.3f}s")

    # Every playlist is judged before anything is reported, so a refusal names each rung that failed
    # rather than only the first. A sitting is stopped by any one of them, and knowing whether one
    # rung or all four is wrong is the difference between an encoder fault and a config fault.
    refused: list[str] = []
    for path in args.playlist:
        durations = extinf_durations(read(path))
        if len(durations) < args.min_segments:
            print(
                f"stage-fingerprint: NOT READY, {label(path)} holds {len(durations)} segments and "
                f"this needs {args.min_segments}."
            )
            print("  A median over fewer is decided by the opening segment, which is short by construction.")
            return EXIT_NOT_READY

        observed = median(durations)
        reasons = refusals(fragment, aof_ratio, args.gop, observed, args.tolerance)
        verdict = "matches" if not reasons else "; ".join(reasons)
        print(f"  {label(path)}: observed median {observed:.3f}s over {len(durations)} segments, {verdict}")
        if reasons:
            refused.append(f"{label(path)} {'; '.join(reasons)}")

    if not refused:
        print("  the stage matches what the driver asked for")
        return EXIT_MATCHES

    print("")
    print("stage-fingerprint: REFUSING TO START. " + ". ".join(refused) + ".")
    print("")
    print("  The knob is the encoder GOP, not hls_fragment. hls_fragment sets the FLOOR and")
    print("  hls_aof_ratio the ceiling, and the GOP decides where inside that range a segment lands.")
    return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())

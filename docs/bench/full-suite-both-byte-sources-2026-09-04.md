# The full suite, green on both byte sources, 2026-09-04

**Claim.** At head `bc9df49`, on the ladder stage cutting 2.0 s segments, the whole live e2e suite
passed twice on one afternoon with no reruns: once with the viewer's bytes coming from the in-tab
node, once with the gateway as the control. Ten preflight gates and 36 tests each time, exit 0 each
time. It is the first full green that carries every fix of 2026-09-01 to 2026-09-04, and the first in
which the quality switch, the rung failover and the segment-loss gap are all asserted inside one run.

The owner asked for exactly this: "a full test live run on both to prove we are fine".

## What ran

| Sitting | Byte source | Began | Ended | Gates | Tests | Suite time |
| ------- | ----------- | ----- | ----- | ----- | ----- | ---------- |
| A | in-tab node (weeb3) | 06:48:44Z | 07:50:12Z | 10 of 10 | 36 of 36 | 3652 s |
| B | gateway (the control) | 07:50:15Z | 08:51:56Z | 10 of 10 | 36 of 36 | 3669 s |

Both were launched by `scratchpad/sitting-both-chain.sh`, unchanged since 2026-09-02, one after the
other and detached. Each launch runs `deploy/scripts/bench-on-host.sh --profile latbench --portSlot 7
--script e2e:run -- E2E_RUN_PROFILE=in-browser`, and sitting B adds `BROWSER_FETCH_BACKEND=gateway`.
The environment beats the profile file by design, so B is the in-browser profile with one value
switched, at the stage's own 2.0 s, which is what the owner ruled a profile switch on one stage must
do. Every launch syncs the host checkout, so both sittings ran the head named above.

Stage at the time: uploader `f53a577` (HLS_FRAGMENT 2.0), client `3796e4a` stamped and served, the
gateway and the four per-rung bee nodes untouched since, all bee 2.8.2. The ten gates that opened
each sitting are the ones described in `docs/e2e-coverage.md`, and sitting A was the first run of
`e2e:run` through the launch script since it gained the ledger guard that morning.

## What passed, in both sittings

- Crash scenarios A, B, D, E, F, G, H, I, J, K and the ladder's own engine restart.
- Every service suite: the ABR ladder gapless on all four rungs, the catalog live to VOD, the happy
  path, `/health` through the lifecycle, two concurrent broadcasts.
- Every viewer test V1 to V10 in a real browser: live playback, the quality switch under a cap, a
  rung going quiet and the viewer stepping down, a finished recording with its whole ladder, the
  broadcast ending on screen, and the five-fault crash matrix.

The 36 counts nested subtests. The 09-02 pair had 33, and the three added since are the segment-loss
and playlist-timeline assertions.

## What it cost

Available chequebook balance per node, BZZ, read by the chain before, between and after.

| Node | Before | After A | Spent in A | After B | Spent in B |
| ------- | ------ | ------- | ---------- | ------- | ---------- |
| 360p | 6.470 | 6.191 | 0.279 | 5.902 | 0.289 |
| 480p | 2.446 | 2.264 | 0.182 | 2.086 | 0.178 |
| 720p | 1.158 | 0.661 | 0.497 | 5.180 | 0.481 |
| 1080p | 2.541 | 1.604 | 0.937 | 5.657 | 0.947 |
| gateway | 11.748 | 11.697 | 0.051 | 11.077 | 0.620 |
| total | | | 1.946 | | 2.515 |

The pair cost 4.461 BZZ of the 5.000 the owner authorised at 06:46:55Z. The publishers cost the same
in both sittings, to within a few hundredths per rung, because publishing does not know who is
watching. The whole difference between the two sittings sits on the gateway node, 0.620 against
0.051, which is where retrieval for a gateway viewer is paid. The 09-03 gateway sitting read 0.619
for the same line. The 720p and 1080p rows jump between A and B because the owner deposited 5 BZZ
into each of those chequebooks from the node's own wallet at about 07:52Z, while B was running.

Sitting A cost 1.946 against about 1.8 predicted from the 09-03 in-tab sitting, which had three
fewer tests.

## Two things a reader of the raw log should know

**A blank balance read is not a drained node.** At 07:52Z both the 720p and the 1080p bee APIs
returned nothing for about half a minute. Sitting B was in scenario B at that moment, the one that
kills the publisher bees and waits past the retry window, and `docker ps` showed all four publisher
containers up for 21 seconds. Thirty seconds later every node answered and the deposits had landed.
Read `docker ps` before reading a zero as money.

**The next run needs a fresh ledger.** The spend ceiling gate compares each node's balance against
the baseline the ledger recorded. Two of those baselines are now below the balances, because of the
deposits, so the ledger written at 06:46:55Z reads those nodes as having spent less than nothing,
and the 09-03 record shows the gate refusing a run in exactly that state. Writing a fresh ledger is
the owner's command, `deploy/scripts/spend-ledger.sh --profile=latbench --portSlot=7
--authorise=<BZZ>`, before anything that spends.

## Not asserted, and not measured

Durations, freeze lengths and recovery times are printed by each suite under a heading that says they
are observations and none of them is asserted. They are in the per-run files below. Host load and the
neighbours on the bench host were not sampled during this pair. This was a correctness run, and its
timings are not a measurement of anything.

## Where the artifacts are

The per-run harness output was rsynced into `docs/bench/` as `browser-*-2026-09-04T07-*` (sitting
A) and `browser-*-2026-09-04T08-*` (sitting B). Those files are matched by the `.gitignore` rules for
per-run output and stay out of git, except the four V2 and V4 summaries kept next to this note and
linked from `INDEX.md`. The chain's own log is `scratchpad/sitting-both-2026-09-04.log` in the
session's scratch directory, and its milestone lines are reproduced in the table above.

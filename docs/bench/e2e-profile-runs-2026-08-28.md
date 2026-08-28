# The first profile runs: the suite watched real viewers, and the viewers had things to say

**2026-08-28, latbench, bee 2.8.2, ladder deploy (4 rungs), suite at `53a4823` lineage.**
Two full-suite runs under the new run profiles, `in-browser` (weeb3, the default) and
`light-client` (gateway, the control), each including the first-ever executions of the real-browser
viewer suites V1 (live playback) and V5 (broadcast ended). Everything below was paid for out of the
owner's fresh 4 BZZ authorization of 2026-08-28T12:45Z.

## Headline results

| Run | Profile | Result | Wall | Cost (BZZ) |
| --- | --- | --- | --- | ---: |
| Baseline (morning, bee 2.8.1) | none, pre-profiles | 18 suites, 24 tests, ALL GREEN | 10.5 min | 0.271 |
| Full run 1 | in-browser | 22 suites, 28 tests, 25 pass 3 fail | 15 min | 0.439 |
| Targeted rerun of the 3 reds | in-browser | B green, V1 V5 red on a 2nd harness bug | 14 min | (in 0.47 below) |
| Viewer retry after fix | in-browser | V5 red on a REAL defect, V1 red on substance | 12 min | ~0.47 total reruns |
| Full run 2 | light-client | 22 suites, 28 tests, 24 pass 4 fail | ~25 min | 0.688 |
| Viewer rerun after client fix | in-browser | **V5 GREEN**, V1 red on substance | 12 min | 0.468 |

All 18 pre-viewer suite files are green on bee 2.8.2 under both profiles, with two exceptions in the
light-client run (H and I) that turned out to be harness defects, not product ones (below).

## Finding 1: a ladder viewer was never told the broadcast ended, found and fixed the same day

V5's first real execution: the broadcaster stopped cleanly, the uploader finalized every rung and
the VOD, and the viewer sat on `live` over a frozen frame for the rest of the watch. The ended
overlay exists and was proven in the 08-27 crash matrix, but that proof was single-rendition. On a
ladder the chain was broken twice, both client-side: the ladder poller read each rung's ENDLIST and
told nobody, and the overlay listens on the group topic that no rung-level signal ever reached.

Fixed in `e843154` (the last rung to finalize ends the group, mirroring the uploader's own
all-rungs VOD rule), deployed via the zero-downtime client recreate, and proven live the same
evening: the rerun watched a real browser pass through `degraded → live → ended`. First time a
ladder viewer has ever been told a broadcast ended. V5 is now a permanent green test over that
whole chain.

## Finding 2: at shipped settings, a viewer cannot hold the 4-rung ladder. Both byte paths

V1 asserts a viewer keeps up with at least 0.95 of wall clock. Three runs, three failures, and the
latency target was the SHIPPED 6 seconds every time (`latencyTarget.configuredS: 6` in every
artifact), so the harsh 2s bench pin of earlier sittings excuses none of this.

| Arm | Byte source | Advance (overall / median) | Rebuffers | Rode | Join behind live | Median buffer |
| --- | --- | --- | ---: | --- | ---: | ---: |
| retry 3, V1 | weeb3 | 0.648 / 0.692 | 75 (91s) | 1080→720 | 1.35s | 0.55s |
| light-client, V1 | gateway | 0.605 / **0.999** | 21 (96s) | 360p | 4.64s | 0.85s |
| after client fix, V1 | weeb3 | 0.711 / — | 75 | 1080→720 | — | — |

Two different failure shapes, one shared outcome:

- The **weeb3** viewer joins nearly at the live edge (1.35s behind, against a 6s target it never
  reaches) and lives on half a second of buffer, so it rebuffers constantly in short strokes while
  riding the high rungs. Its twin arm in V5 joined 2.74s behind and had only 9 rebuffers in its
  live phase, so join position at the edge is a large part of the starvation.
- The **gateway** viewer rode the lowest rung and played PERFECTLY most of the time (median
  advance 0.999) but froze for long stretches (83 stalled samples, feed `degraded` seen), which
  points at the feed/manifest path rather than segment bandwidth.

Instruments were SOUND on every arm, byte-source proofs held (weeb3/weeb3, gateway/gateway), and
the ladder published all rungs each time. This is a real product-level result and the direct input
to the open production-topology decision. The V1 threshold has deliberately NOT been touched.

Context that sharpens it: sitting 2 (same deploy, harsher 2s pin) measured 88% at 1080p in-tab and
94% at 360p via gateway. Today's shipped-config numbers are worse than the pinned ones. Deltas
since: bee 2.8.2 on both nodes, the suite harness instead of the bench wrapper, different hours on
a shared host. Attribution between those needs a designed comparison, not a rerun.

## Finding 3: bee 2.8.2 did not reproduce its one red

`bee-outage-long` scenario B (outage longer than the retry window must drop segments) failed once
on 2.8.2 right after the upgrade, with indices contiguous 1..9, meaning the stream recovered
everything and outperformed the test's premise. It was green on 2.8.1 the same morning, green on
the 2.8.2 rerun, and green in the light-client full run. Filed as flaky-once and watched, not
edited.

## The harness earned its scars: four defects of ours, found by paying for them

1. `--group-add $(getent group docker ...)` expands empty inside the suite's own container, and the
   empty substitution ate the next flag. Every viewer arm failed at launch. Fixed `3139703`, the
   gid now comes off the mounted socket, true in both namespaces.
2. The artifact was read at the host path from inside the container, where the checkout is `/repo`.
   Both arms ran fully and wrote artifacts nothing read. Fixed `2e91e7d`, the path is composed for
   whoever actually reads it (`Host.isLocal`).
3. Scenario H counted EVERY broadcast's finalize in its log window, so scenario E's late-draining
   flip inside H's window read as one recording published twice. The uploader log disproved it, no
   ladder uuid ever finalized twice. Fixed `643212d`, finalize counts are scoped to the broadcasts
   announced in the window, all six consumer suites switched.
4. Scenario I trusted the catalog fetch's shape mid-restart, and a gateway 503 envelope became a
   TypeError instead of a retry. Fixed `53a4823`, the boundary validates and the callers'
   catch-to-empty reads it as not-yet.

The common lesson, twice in one day: a command or path template proven in one execution context is
unproven in every other.

## Money

Booked off chequebook `availableBalance` deltas against the ledger's recorded starts.

| | BZZ |
| --- | ---: |
| Authorized 2026-08-28T12:45Z | 4.000 |
| Baseline + full run 1 + reruns + full run 2 + final viewer rerun | 2.715 (uploader) + 0.064 (gateway) |
| **Spent total** | **2.779** |
| Remaining | 1.221 |

Batch `28cd0d39` after the owner's 20 BZZ topup: TTL ~12.5 days at the last read (dies ~Sep 10),
utilization 80/256. Proving the promoted crash-matrix suites live (six browser scenarios) will cost
roughly 1.0 BZZ and therefore needs a fresh authorization or a scoped decision when it lands.

## Still red, and why that is the correct state

- **V1 under both profiles**: a true product reading (Finding 2) awaiting the topology decision.
  Making it green by lowering the floor would delete the finding.
- Everything else in both profiles is green as of the fixes above, pending one full paid
  confirmation run per profile once the current build wave (crash-matrix promotion, spend-ceiling
  preflight, chequebook startup gate) merges.

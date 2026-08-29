# Plan: make the viewer side of ABR a tested property

Written 2026-08-29, after the owner asked where the ABR viewer tests and the per-rung publisher
tests were. The answer was that neither exists. This is the plan to get them.

## The gap, stated once

**Every ABR test reads the uploader's log. None of them opens a browser.** Seven assertions across
two suites prove the encoder produced four rungs, one uploader wrote all four without dropping
anything, they stayed grouped as one catalog entry, and they came back after an engine restart.

That is the plumbing. It says nothing about a viewer receiving more than one quality, and nothing
about ever switching between them.

Seven of the twenty-three suites do open a real browser, and they carry live playback, the end of a
broadcast, and five crash faults. ⛔ **None of the seven is an ABR test.** VOD and concurrent
broadcasts are also unwatched.

⚠️ `suites/scenarios/gateway-outage-viewer.test.ts` has "viewer" in its name and opens no browser.
It tests the upload side while a viewer's gateway is down.

## Phase 1 — assert what the watching tests already observe

**Free. No infrastructure, no broadcast, no BZZ.** The data is already captured and printed under
"observations, none of them asserted".

V1 records the rung a viewer actually received (1920x1080 on the last in-browser run) and asserts
nothing about it. The five crash suites capture the same. Promote the ones that are facts about the
product rather than about timing:

- the viewer received a rung that is **in `ABR_LADDER`**, rather than any resolution at all
- the viewer received a **single consistent** rung for the whole watch, or a set of rungs all of
  which are in the ladder
- ⛔ **not** which rung. Which rung a player picks is its own adaptive decision and pinning it would
  be a performance assertion wearing a correctness coat. See
  [owner rule](../..) on correctness over performance.

**Done when:** a viewer silently stuck on a rung outside the configured ladder fails a test.

**What it does not buy:** it cannot catch a failure to *switch*. That is phase 2.

## Phase 2 — the three watching tests that were planned and never built

Run time and harness work. No new infrastructure. Numbers reserved in `docs/e2e-coverage.md`.

### V2, quality switch works

Throttle the tab's network mid-playback through the debug protocol, assert the player steps **down**
a rung and keeps playing, release the throttle, assert it climbs back.

⛔ **Assert the transition, never the timing of it.** "Moved to a lower rung and never stopped
playing" is correctness. "Moved within N seconds" is a performance threshold and does not belong
here.

⚠️ The in-browser and gateway profiles will behave differently, because their byte sources differ by
an order of magnitude in request count. Run both, expect both to switch, compare nothing.

**Done when:** a client that ignores bandwidth and rides one rung into a stall fails.

### V3, a rung goes quiet and the viewer steps down

Stop one rung at the engine while a viewer watches it. Assert the viewer moves to a surviving rung
rather than freezing, and that the overlay does not claim the broadcast ended.

**Done when:** a viewer frozen on a dead rung while three healthy ones sit beside it fails.

### V4, VOD playback in a browser

Play a finished ladder recording end to end. Assert the master and every rung resolve, the picture
advances, and the timeline is the whole broadcast.

**Done when:** a recording that only plays its lowest rung fails.

### Also here, cheaply

The ladder version of `multi-stream-concurrent`, watched. Today that suite is single-rendition only.

## Phase 3 — per-rung bee nodes, the shape we meant to ship

⛔ **`BEE_PUBLISHERS` is built, unit-tested, and has never been deployed or tested live.** On our
stack it is set to empty, so `BeePublisherPool` takes the single-node path and one bee node carries
all four rungs. The e2e suite mentions the variable in **one comment** and asserts nothing.

⛔⛔ **Every throughput and cost figure this project has produced is therefore a single-node figure.**
They do not describe the deployment shape the design intends.

Blocked on money and infrastructure, in this order:

1. **Three more uploading bee nodes**, each with its own funded chequebook and its own postage batch.
   Price this properly before asking, rather than guessing.
2. **A preflight that refuses the lie.** The run declares per-rung or single; the gate reads what the
   uploader is actually configured with and stops before any spend if they disagree. Same shape as
   the ABR, browser and segment-length gates. ⛔ Without it, a per-rung run that silently fell back
   to one node produces a single-node result wearing a per-rung label, which is a wrong number
   rather than a missing one.
3. **The tests that only mean something with four nodes:**
   - each rung's bytes actually leave through its own node, proven from the four nodes' **own**
     counters and not from the uploader's log
   - one node's batch runs dry and only that rung degrades, the other three keep publishing
   - one node is killed and the ladder stays one catalog entry across the survivors
   - a viewer keeps a working ladder throughout

**Done when:** losing one node costs one quality instead of the broadcast, and a test says so.

## Open reds, not part of the phases

- **H, killed inside finalize.** Fixed and proven green at 2s segments on 2026-08-29, red again at
  0.5s. Either the fix is segment-length sensitive or the shorter stage reopens the window.
- **E, media-engine restart.** Cancelled by a timeout rather than failing an assertion. Undiagnosed.
- **V8's counter is soft.** `discontinuitiesArmed` counts log lines across three different messages,
  one of which repeats the same segment up to four times. It is not a count of discontinuities and
  any figure quoted from it should be treated as an upper bound.

## Order and why

1, then 2, then 3. Phase 1 is free and closes the worst gap in what the current green already
claims. Phase 2 makes ABR a tested feature rather than a described one. Phase 3 is the largest, is
the only one blocked on money, and it replaces a body of single-node measurements, so it is worth
doing after the viewer side is trustworthy enough to judge it by.

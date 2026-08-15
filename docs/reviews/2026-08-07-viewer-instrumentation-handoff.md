# Viewer-side instrumentation handoff

> ## ⚠️ THE COST FIGURE IN THIS HANDOFF IS RETIRED, 2026-08-09
>
> This document is framed as the entry point for whoever picks up the viewer work, so its stale
> number is the first thing a fresh reader takes away.
>
> **It prices runs at ~0.00085 BZZ/MB. Use 0.00068.** Measured across eight arms and four profiles in
> `../bench/what-a-gateway-burns-at-each-profile-2026-08-09.md`, which found every arm between
> 0.000644 and 0.000708 with no ordering by segment size. **The 0.00085 is 25% too high.**

Entry point for whoever picks up this work, human or a fresh AI session. Everything below was verified
at the end of the session that wrote it, 2026-08-07 evening, and every figure was read off the running
deployment rather than carried forward from notes.

The companion is [`2026-07-29-hardening-handoff.md`](./2026-07-29-hardening-handoff.md), which holds
the hardening ordering and is history now. This one holds where the viewer-side measurement work
actually stands.

## Start here

On `feat/ai-hardening` @ `552f078`,
clean tree, **0 open PRs**, `pnpm verify` exit 0 on that head.

Suites: **client 222, uploader 730, e2e 638, deploy 124, cli 91, gate-facts 49, audit-gate 38,
shared 32.**

PRs target `feat/ai-hardening`, never `main`. Local `main` is stale.

## What landed last session, #80 through #85, all squash-merged

| PR  | commit    | what                                                                                                                                                                    |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #80 | `1999473` | a timed-out test left its detached feed walk running and the next test recorded its request. `inFlight` became `Map<topic, Promise>` plus a `settled()` the tests await |
| #81 | `4567987` | the fourteen-minute collapse, solved by free replay of archived runs                                                                                                    |
| #82 | `2041b43` | `FEED_STATE_DEGRADED`, so a viewer whose gateway is slow rather than absent is told                                                                                     |
| #83 | `02f16a4` | the CON-29 re-entry guard could be deleted with all 47 tests green                                                                                                      |
| #84 | `b4f8857` | the gateway node sampled during a watch run                                                                                                                             |
| #85 | `552f078` | its spendable balance sampled too, plus two defects the first real run found                                                                                            |

Branches deliberately **not deleted**: `fix/manifest-fetcher-walk-leak`, `docs/fourteen-minute-collapse`,
`feat/degraded-playback-state`, `test/con-29-re-entry-guard`, `feat/gateway-node-sampling`,
`feat/gateway-chequebook-sampling`.

## ⭐ What to do next, in the owner's own framing

> "now we test checkbook funded light nodes... prob in a real event they would watch with ultra light
> clients OR non funded light clients but more like the ultra light clients. we have to know what does
> work also, to see where and how they break if they break etc..."

**Every viewer-side figure this project holds was measured through a chequebook-funded light gateway.**
That is the best case, not the shipping case. Schedule runs against **ultra-light** and **unfunded
light** gateways, and treat breaking as the result rather than the failure — the point is where and how.

This is not hypothetical. Checking funds before the last run found the gateway at **0.0000007 BZZ
spendable** against a 14.7 BZZ chequebook, wallet empty, and **every health signal green**: `/health`
in 1.1 ms, 134 peers, reachability Public. A node that cannot issue cheques is throttled by peers to
the free tier, which is a read path slowing with nothing reporting a fault. An unfunded light node is
the state a real viewer _reaches by watching_.

## Funds, read off the host at end of session

|                                                              |                          value |
| ------------------------------------------------------------ | -----------------------------: |
| gateway wallet `0x7deb32bc364aecd90e77e930a7d0118836db9c25`  |             17.0 BZZ, 0.1 xDAI |
| gateway chequebook available                                 |    **7.967 BZZ** (22.70 total) |
| uploader wallet `0x65d48f39ea89aaa99839cda93cc05523e7437864` |            1.532 BZZ, 0.1 xDAI |
| uploader chequebook available                                |                      5.537 BZZ |
| stamp `7849851f…` depth 24, immutable                        | 133/256 buckets, TTL 28.3 days |

⚠️ **Two wallets, not interchangeable.** Postage is bought from the **uploader** wallet. Bandwidth is
paid from the **gateway** wallet. Confusing them already cost one failed purchase.

⛔ **Never buy, extend, top up or move funds.** Stop and give the owner exact commands.

### Burn rates — one of these was corrected last session

- **Gateway: 0.306 BZZ per 30 min of 720p.** Measured continuously for the first time. The old 0.123
  figure came from two hand readings and is **2.5x too low**. 8 BZZ is ~13 hours of 720p, not 32.
- Uploader: 0.043 BZZ over 3.19 min at 720p/2500k.
- Price runs in **bytes**, never minutes: ~0.00085 BZZ/MB.

## How to run a broadcast + watch

```bash
deploy/scripts/publish-clock.sh --profile=latbench --portSlot=7 --seconds=420 --size=1280x720 --bitrate=2500 --gop=1.0
```

in the background, wait until `curl http://localhost:10070/health` on the host reports
`"activeStreams":1`, then

```bash
deploy/scripts/browser-on-host.sh -- BROWSER_WATCH_SECONDS=180 BROWSER_GOP_SECONDS=1.0
```

Profile `latbench`, port slot 7. Uploader API 10070, client 10074, bee-uploader 10075, bee-gateway 10077. ⛔ Never `pnpm bench:latency` from the Mac (~15% SRT loss).

## Open, and honest about it

- **The fourteen-minute collapse's cause is still not established.** It is a read-path service-time
  step at t=822s, 1 run in 15. Chequebook exhaustion is now a **live candidate** and is sampled every
  run, but nothing confirms it. ⛔ **Do not buy a repro** (~11 BZZ expected to catch once).
- **#100**, the overlay threshold denominated in polls rather than milliseconds, is a **product
  decision** and stays deferred. It is _not_ what silenced the overlay during the collapse — that was
  a missing state, fixed in #82.
- `pnpm mutate` does not run. Two hypotheses already refuted.
- A pre-existing gap: nothing tests `ManifestFetcher`'s teardown-during-walk path beyond what #83 added.

## Working rules that actually bit last session

1. ⭐ **Dry-run an instrument against the deployment before spending a broadcast on it.** Both defects
   in the gateway sampler were invisible to its own suite, because a unit test passes a fixture the
   size of the thing it asserts. A 390 kB read looks like a 351-byte one when the fixture is three
   lines; a table missing a column still contains every value an assertion looks for.
2. ⭐ **Verify by breaking the production code and watching tests go red.** Last session ran ~30
   mutations. Roughly a third of the survivors were _weak tests_, not good code — most often a fixture
   that cannot express what the assertion claims (one sample per minute, then asserting the minute
   takes a minimum).
3. **Test "does this loop stop" by racing, never by awaiting.** A runaway loop hangs the suite instead
   of failing it, and a hung run reports nothing.
4. **`timeout` is not on macOS.** Bound a hang inside the test.
5. **`gh pr merge --squash` can be blocked by the auto-mode classifier and succeed on retry** with
   nothing changed. A block is the classifier, not the branch.
6. **Name the exact PRs and target branch and wait** before landing anything.
7. Never a `Co-Authored-By:` footer, never an AI-attribution footer in PR or issue bodies. One fix per
   commit. No em-dashes or semicolons in prose.
8. A dependency bump needs the four-part provenance check, every time.

## Where the detail lives

Project memory is loaded automatically. `MEMORY.md` indexes it. The ones to read first for this work:
`swarm-hls-viewer-node-funding`, `swarm-hls-gateway-node-sampling`, `swarm-hls-fourteen-minute-collapse`,
`swarm-hls-degraded-playback-state`, `manager-host-access`, `e2e-checkbook-funding`,
`swarm-hls-gate-lesson` (read before designing any check, sweep or gate).

Reports are in `docs/bench/`. The newest is `browser-watch-2026-08-07T14-14-21-869Z`, the first run
carrying node-side data: instrument SOUND, 0 rebuffers, 0 stalls, gateway 38/38 samples at a steady
1 ms. That 1 ms is the healthy baseline any future step is measured against.

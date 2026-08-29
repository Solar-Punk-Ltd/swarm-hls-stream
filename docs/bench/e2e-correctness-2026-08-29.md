# The day the e2e suite started testing correctness, 2026-08-29

Live, on the latbench deployment (slot 7), four rung ABR ladder, real Chrome against a real
broadcast. Every figure here was taken on the running stack, not simulated.

## What changed about the suite itself

The owner's rule, stated this day and now the governing one for everything under `e2e/`:

> on e2e tests, what we care about is not performance tests. Here we test feature correctness, that
> our solution is working and working properly and stably. Performance tests are different things.
> Of course it's good to know and persist and remember what we have here during e2e just to be
> aware. But our job here with these is code, feature correctness and stability check.

Acted on in two ways.

**Every performance ceiling came out of the viewer suites.** V1 and V6 through V10 dropped
`freezeRefusal`, `minFreezeMs`, `maxFreezeMs`, `minBufferMs`, `resumeRefusal.withinMs`, a 0.95
playback advance floor and fifteen threshold constants. They now assert recovery, overlay
truthfulness and continuity, and print their timings under a heading that says
`observations, none of them asserted`.

⛔ **The ceilings were unsound anyway**, which is worth recording separately from the rule. All of
them were derived from the 2026-08-27 crash matrix, whose own header says single-rendition 720p at a
0.5 second GOP. They were being applied to a four rung ladder at two second segments. A threshold
carried across a stage change is a number about a different deployment.

**V8 gained a correctness question it did not have.** The writer's node is paused for eight seconds,
which is inside the uploader's retry window, so no segment may be lost and no discontinuity may be
armed. That is a fact about the product, and it holds or it does not.

## The stage was cutting the wrong length, and it explains a day of readings

`e2e/profiles/in-browser.env` now declares `E2E_EXPECT_SEGMENT_S=2`, and
`suites/preflight/segment-length.test.ts` reads the config SRS was actually exec'd on and refuses a
mismatch before the first frame. It costs no broadcast and no BZZ.

The law comes from the sibling repo `swarm-stream-loadlab`, measured 2026-08-16:

| segment length | 0.5s | 2s |
| --- | --- | --- |
| sustained playback rate | 0.426x | 1.000x |
| buffer held ahead | 0.5 to 3.5s | ~90s |
| arms | 1 | 2 |

weeb-3 admits about one segment per second whatever its peer count, so a 0.5 second profile needs
two admissions a second against a ceiling near one. Peers were never the constraint, so no amount of
peering moves it.

⛔ **What it cost here.** Our stage published 0.5s and the in-browser profile ran against it. Live
in-tab readings sat at 0.35 to 0.68 of realtime on a 44ms buffer. That is the law, not a client
defect, and it was very nearly diagnosed as an ABR rung-selection bug instead.

⚠️ **The gateway path has the opposite optimum**, 0.5s beating 2s at 1.55s against 3.88s latency
across 21 funded arms. One number cannot serve both byte sources. Two seconds also costs about 16
seconds of glass-to-glass because `HLS_LIVE_SYNC_SEGMENTS=8`. This is an open product question, not
a settled one.

⛔⛔ **The two profiles are now two stages, not an arm and its control.** Any in-browser versus
light-client comparison drawn from runs at different segment lengths is comparing two things at
once. The earlier synthesis in `e2e-profile-runs-2026-08-28.md` needs reading with that caveat.

## Flipping the stage moved the scoreboard from 22 to 27 of 29

No product code changed for those five. The stage did.

| | before | after |
| --- | --- | --- |
| preflight | 5/5 | 6/6 |
| scenarios + service + viewer | 22/29 | 27/29 |

The five that went green were V1, V7, V8, V9 and V10, every one of them a viewer suite, every one of
them starved by a stage cutting four times too fine for an in-tab node.

## The two that stayed red, and they were different in kind

### B, bee crash past the retry window: a stale test

The product was correct. The discontinuity was armed, which is the feature under test. The suite
then looked for a hole in the segment numbering and failed on `got: 5,6,7,8`.

The warmup gate counted three segments **across the merged ladder**. At two second segments that
trips before the 1080p rung has uploaded even one, so that rung entered the outage with no history
at all. Its first surviving index was whatever came after, and the hole the outage tore had nothing
on its left to make it visible.

Fixed by counting warmup and resume **per rung**. The resume wait moved too, for the same reason:
waiting on the fastest rung would check a rung that had not resumed yet and read its unbroken
pre-outage run as an outage that tore no hole.

### V6, gateway taken away and given back: a real client defect

Measured: the picture froze **26.6 seconds**, starting 7.2s after the fault, moving again 9.8s after
the service answered. Two rebuffers. **The client said nothing at all while frozen.**

Rendering nothing is how this client says the feed is live, so the viewer was told everything was
fine while looking at a frozen frame. `reconnecting`, `stalled` and `degraded` were all available
and all true.

⭐⭐⭐ **The cause is the ladder's two kinds of topic.** A ladder broadcast is one entry topic, the
one a viewer's link carries, and four or five per-session rung topics discovered from the master
playlist. The overlay subscribes to the entry topic. `LadderFeedPoller` records every gateway fault
against the rung it happened on. So the two states describing a gateway problem were written under a
name nobody read.

| state | recorded against | reached the overlay |
| --- | --- | --- |
| ended | the group, since the V5 fix | yes |
| degraded | the entry topic, off the video element | yes |
| reconnecting | the rung | **no** |
| stalled | the rung | **no** |

That the V5 fix had already routed `ended` to the group by hand is the whole bug class walking past
and being fixed one state at a time.

Fixed by folding a group's state from its rungs, on **agreement across every rung rather than the
worst of them**: one gateway serves all five feeds, so a rung being served is proof the gateway
answers. Same all-rungs rule the ended signal uses.

⛔ Two traps inside that fix, both found by tests that failed first. A stopped rung must leave the
membership, because it records nothing and would read as a healthy rung pinning the group to live.
And untracking the whole group on any stop is equally wrong, because a source torn down and rebuilt
starts its new rungs before it stops the old ones.

## The lesson

**An identity model with two kinds of name will silently split every signal that crosses it, and the
failure mode is silence rather than an error.** Nothing threw, nothing logged, every counter was
correct. They were correct under a key nobody read.

The e2e suite is the only instrument that could see it, because it is the only one that watches what
a viewer is actually shown. A unit test of the tracker passes either way.

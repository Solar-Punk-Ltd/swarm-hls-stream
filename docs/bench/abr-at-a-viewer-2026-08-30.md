# ABR at a viewer, watched for the first time

**2026-08-30, latbench slot 7, four rung ladder. BOTH profiles run:** light-client (gateway byte
source) on the 0.5s stage, then in-browser (weeb-3 node in the tab) on a 2s stage. Three tests that
had never existed before this day, against a real browser watching a real broadcast.

⛔⛔ **The two profiles are two STAGES, not an arm and its control.** They cut at different segment
lengths on purpose, because the two byte sources measured opposite optima. Every figure below is
labelled with the profile it came from and no figure from one may be read against the other.

| | gateway | in-tab |
| --- | :---: | :---: |
| V2 the ladder adapts | ✅ | ⛔ **it cannot see the constraint** |
| V3 a dead rung | ⛔ stranded | ⛔ stranded |
| V4 a recording plays whole | ✅ | ✅ |

## What this settles

Until today, every ABR test in this repository read the **uploader's log**. That can say four rungs
were published and gapless. It cannot say that any player ever used one. Seven browser suites watched
a player, all on an unconstrained link, where a correct player has no reason to change rung.

So the ladder was four times the transcode and four times the publishing cost, with the feature it
buys unobserved.

## ✅ V2: a viewer whose connection gets worse keeps watching

The tab's download was capped at 1200 kbps, the bitrate of the rung below the one the viewer had
settled on.

| | |
| --- | ---: |
| rung before the cap | 720p |
| lowest rung while capped | 360p |
| tallest rung after the cap lifted | 480p |
| the player's own bandwidth estimate | 27583 → 893 → 2110 kbps |
| level changes | 7 |
| media seconds per wall second while capped | 0.731 |
| came down, after the cap | 3.0s |
| climbed back, after the lift | 46.7s |

⛔ The two durations are measured and filed and neither is asserted. Owner ruling of 2026-08-29.

**The ladder adapts.** The connection got worse, the player came down two rungs, the picture kept
moving, and it climbed back when the link was released.

⭐ **The cap has to come from the rung being played, not from the ladder.** An earlier arm the same
night capped at the ladder's second lowest bitrate and found a viewer already sitting on 360p, the
bottom rung. 360p stayed affordable, the player correctly did not move, and the test reported "a
ladder nobody descends" about a player that had behaved perfectly. A viewer already on the bottom
rung is now refused rather than failed: no bandwidth gives them somewhere to go.

⚠️ **The starting rung is not stable across runs on this profile.** One arm settled on 360p and the
next on 720p, same stage, same ladder, minutes apart. Nothing here explains that and no reading in
this document depends on it.

## ⛔⛔⛔ V2 in-tab: ABR CANNOT SEE THE CONSTRAINT IT EXISTS TO REACT TO

The sharpest result of the night, and it was very nearly filed as a harness failure.

Capped at 2800 kbps, the rung below the 1080p this viewer had settled on.

| | before the cap | while capped | after |
| --- | ---: | ---: | ---: |
| rung | 1080p | **1080p** | 1080p |
| media seconds per wall second | **1.000** | **0.604** | 1.347 |
| the player's own bandwidth estimate | 97751 kbps | **74221 kbps** | 51118 kbps |

Level changes: **0**.

**The cap unmistakably reached the viewer.** Their playback fell from keeping up exactly to 0.604 of
realtime. What the cap did not reach is hls.js's **measurement**: it read 74 Mbps on a link capped at
2.8 Mbps and never moved off the top rung.

⛔⛔ **The mechanism.** hls.js derives its bandwidth estimate from its own fragment load timings. On
the in-tab path a fragment leaves the local node at memory speed once the node holds it, so what
hls.js times is the handover from the node, never the node's retrieval from Swarm. The retrieval is
the thing that got slower. **ABR's input signal does not measure the constraint, so ABR cannot
protect an in-tab viewer, and the ladder is inert on the path this project exists to build.**

⭐ This explains a reading already on file. An in-tab viewer was measured riding 1080p on a 44ms
buffer with the documented starvation fallback never firing. The fallback never fired because the
signal it waits on never moves.

⛔ **The gate that hid it, and it was mine.** V2 first refused any run whose estimate stayed above the
cap, on the reasoning that a player timing its own loads cannot read more than the link carries. True
through a gateway, false in a tab. The refusal said "this run proves nothing" about the most
important thing measured all night. The gate now asks what a viewer could FEEL: either the player
moved rung, or the picture got worse. The estimate is printed and decides nothing.

## ⛔ V3: a viewer whose rung goes quiet is stranded on it

The transcode producing the rung the viewer had settled on was stopped for 90 seconds. Three healthy
rungs published throughout.

| | |
| --- | ---: |
| rung before, during, after | 360p, 360p, 360p |
| level changes | **0** |
| longest stretch the picture did not move | **103.2s** |
| samples where playback did not advance | 122 of 194 |
| media seconds per wall second, whole session | 0.358 |
| rebuffers | 6, totalling 25.0s |
| fatal errors | 0 |
| what the client said while the picture was stopped | **nothing** |
| feed states the viewer passed through | **`live`, and only `live`** |

### Two separate defects, and the second is worse

**1. There is no failover.** hls.js changes level on measured bandwidth and on fragment load
**errors**. A Swarm feed that stops advancing produces neither: it does not error, it stops offering
fragments, and a player waiting for one it was never offered has nothing to react to. So the ladder
buys a viewer nothing when the rung they are on dies. Three renditions sat healthy beside this viewer
for a minute and a half and the player never looked at them.

**2. The overlay said the stream was live for the whole 103 seconds, and that is a rule working as
designed.** The ladder overlay fix of 2026-08-29 folds rung health by **agreement**: a group is
unwell only when *every* rung agrees it is. That is correct for the fault it was built for, because
one gateway serves all five feeds, so a single rung being served proves the gateway answers.

⛔⛔ **It is exactly wrong for a single-rung outage, which is the one case where a viewer can be
frozen while the broadcast is genuinely healthy.** The same rule that closed one blindness opened
another, and neither is visible from the uploader's side.

### The in-tab arm agrees, and is worse

Same fault on the in-browser profile, with the viewer on 1080p instead of 360p:

| | gateway | in-tab |
| --- | ---: | ---: |
| rung before / during / after | 360p / 360p / 360p | 1080p / 1080p / 1080p |
| level changes | 0 | 0 |
| media seconds per wall second while quiet | 0.481 | **0.088** |
| longest freeze | 103.2s | 87.2s |

⭐ Both byte sources, both starting rungs, top of the ladder and bottom of it: **no failover, on
either path.** The in-tab picture was essentially stopped, at 0.088 of realtime.

### What this is not

Not a timing failure. Nothing in V3 asserts a duration, and the freeze figures are recorded rather
than compared. The case is red because the viewer never moved off a rung that had stopped existing.

## ✅ V4: a finished recording plays back whole, with its whole ladder

| | gateway run 1 | gateway run 2 | in-tab |
| --- | ---: | ---: | ---: |
| media published | 50.0s | 43.0s | 32.0s |
| duration the recording reports | 49.0s | 42.0s | 30.4s |
| shortfall, against a 2s tolerance | 1.0s | 1.0s | 1.6s |
| rungs the recording offered | all four | all four | all four |

⭐ **Three for three, on both byte sources and both stages.** The one thing tonight that simply works.

The 1.0s shortfall in both runs is the partial segment a clean stop always leaves behind, which is
why the tolerance is arithmetic rather than a threshold.

⛔ **What this closes.** A ladder recording whose master resolved and whose upper rung playlists did
not plays *perfectly* at its bottom rung: it starts, the duration is finite, the seeks land, the
picture moves. Every reading the previous VOD driver took called that a pass.

## The runs

Three sittings, all light-client, all on the 0.5s stage. The first two failed on defects in the tests
rather than in the product, and both are recorded because the shape of the mistake repeated:

1. **Both new drivers were unreachable.** The root `package.json` proxies every `browser:*` script to
   the e2e package and the drivers run from the repo root. The two new ones were registered only in
   `e2e/package.json`, so both arms died with exit 254 in six seconds with the broadcast already
   started. A guard for exactly this existed and could not see them, because it scans shell drivers
   and these are launched from TypeScript.
2. **V4 could not address a ladder recording.** It read `announcedLiveStreams`, and a ladder
   deployment writes no `Adding stream to list` line at all. It now finds the recording through the
   catalog, which is how a viewer finds it and the only place the owner and the master topic appear
   together.
3. **V3 ran its whole 276 second broadcast and then threw in the artifact reader**, because the
   driver wrote a recovery verdict without the scenario and fault blocks the reader requires. Every
   unit test passed, because the fixture was more complete than the driver.

4. **V2's own gate refused the night's most important finding**, described above.

Total spend across four sittings: **about 1.53 BZZ** of the 8.1 authorised.

## Artifacts

Gateway: `browser-quality-2026-08-30T02-23-53-797Z.md`,
`browser-rung-outage-2026-08-30T02-28-52-286Z.md`, `browser-vod-2026-08-30T02-35-18-280Z.md`.

In-tab: `browser-quality-2026-08-30T02-42-44-415Z.md`,
`browser-rung-outage-2026-08-30T02-47-03-957Z.md`, `browser-vod-2026-08-30T02-52-28-756Z.md`.

## Open

- **Three product defects are unfiled and none has an owner decision.** ABR blind on the in-tab path,
  no failover for a dead rung on either path, and the overlay silent through both.
- **The stage was left cutting 2 seconds**, because in-browser is the declared default profile. The
  gateway arms above were taken at 0.5.
- **The starting rung varies run to run on the gateway profile**, 360p then 720p, minutes apart,
  unexplained. It did not vary in-tab, which sat on 1080p in both arms.
- **V2 has never been seen to pass in-tab**, because it cannot until ABR can see the constraint. The
  red is correct and will stay red until that is a product decision.

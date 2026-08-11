# Prediction, written and committed BEFORE the abel-1 sustain sitting

**2026-08-11.** Committed before the run rather than kept in a scratchpad, so that neither model below
can be adjusted after the number arrives. The previous sustain prediction was written the same way and
called 0.69 against a measured 0.6734, which is the only reason its mechanism is believed.

## The run

`window.__sustainStream = 'abel-1'`, twelve minutes, weeb-3's own player, one focused tab, no gateway
in the path. A third party VOD that the publisher reports plays fine through this same in-browser node.

| | latbench (what every prior sitting used) | **abel-1** |
| --- | ---: | ---: |
| segment duration | 0.266s | **4.167s** |
| segment size | 90 KB | **4,241 KB** |
| bitrate | 2.77 Mbps | **8.34 Mbps** |
| **KB/s the path must deliver** | 338 | **1,018** |

## ⛔ THE TWO MODELS DISAGREE, AND THAT IS WHY THIS RUN IS WORTH A HUMAN'S TWELVE MINUTES

I framed this earlier today as a positive control that should sustain comfortably, on the grounds that
a viewer of a 4.167s stream owes only 0.24 fetches per second against the ~2.75 per second a browser
node manages. **That reasoning is wrong and is withdrawn here.** The 2.75 was measured on 90 KB
fetches, so it is a byte rate wearing a fetch rate's clothes: 2.75 x 90 KB is 248 KB/s. Dividing a
demand in bytes by a rate in fetches only works if fetch time is independent of size, and it is not.

### Model A, the segment-level ceiling: ⛔ ratio ~0.23

weeb-3 runs at most **four segment loads at once**: one foreground, which is exempt, plus
`HLS_PREFETCH_BODY_MAX_PARALLEL = 3` (`src/stream_hls.rs:3720`). We measured **c4 = 235 KB/s**. If that
is the ceiling however the bytes are packaged, then 235 / 1,018 = **0.23**, a stream that plays a
quarter of realtime. Even the best aggregate ever measured on this node, 467 KB/s at a concurrency the
player never uses, gives only 0.46.

**This model is the one with a track record.** It predicted 235 / 338 = 0.69 for the latbench sitting
and that run returned 0.6734.

### Model B, the chunk-level ceiling: ✅ sustains, ratio >= 1.0

The requests that actually cross the network are **chunk** retrievals, and those are capped far higher:
`RETRIEVE_CHUNK_CONCURRENCY = 2_048`, a semaphore at `src/lib.rs:4152`. Segment size decides how many
chunks one segment load puts in flight:

| profile | chunks per segment | at 4 segments in flight | share of the 2,048 semaphore |
| --- | ---: | ---: | ---: |
| latbench, 90 KB | ~23 | ~92 | **4.5%** |
| **abel-1, 4,241 KB** | **~1,060** | **~4,240** | **saturated** |

⭐ On this model every throughput figure we hold was taken on a **starved** node. A 90 KB segment cannot
put enough chunks in flight to reach the limit that matters, so our ceiling is a fact about our segment
size and not about the node.

### ⭐⭐ Three independent measurements already line up on chunks rather than segments

| what was running | chunks in flight | measured |
| --- | ---: | ---: |
| 4 x 90 KB | ~92 | 235 KB/s |
| 16 x 90 KB | ~368 | 410-467 KB/s |
| **1 x 1.3 MB** | ~333 | **336 KB/s** |

The last row is one fetch, alone, and it lands with the sixteen-way arm rather than the one-way arm.
Grouping the same chunk count into 1 segment or 16 gives nearly the same throughput, which is what
Model B says and what Model A cannot explain.

## The number I am committing to

Extrapolating the three rows above, throughput grows roughly with the square root of chunks in flight:
92 to 368 is 4x the chunks for 1.87x the bytes. Carrying that to a saturated 2,048 gives **~1,040 KB/s**,
which sits almost exactly on abel-1's 1,018 KB/s demand.

⚠️ That is an extrapolation across 5.6x, from three points, so its error bars are wide enough to cover
both verdicts. **I am not able to call this run, and saying so now is the point of writing it down.**

- **Model A correct** → ratio 0.20 to 0.30, heavy stalling.
- **Model B correct** → ratio at or above 0.999, no stalling.
- **Anything between 0.4 and 0.9** → both models are wrong and throughput depends on something neither
  captures, most likely how well the content is replicated.

## What each outcome licenses, decided in advance

**If it sustains:** every KB/s figure this project holds for the in-browser node is re-scoped to "our
90 KB segments on an unfunded node" and stops being a node property. #60's ceiling, the 1.8 Mbps
profile advice in [[swarm-hls-browser-sustain]], and the fragment-size conclusion all need re-reading,
because they would all be measurements of a starved retrieval path. The follow-up is then our shipping
1.0s profile on the same node in the same hour.

**If it does not sustain:** the premise is what needs checking, not the node. Ask the publisher whether
the playback was really gateway-less, on the same network, and on an unfunded node, because our own
instrument would then be reproducing his stream's behaviour faithfully and the disagreement is about
the setup rather than the result.

## ⛔⛔ ADDENDUM, still before the run: our own data says objects THIS SIZE mostly do not arrive

Added after the re-analysis in `chunks-in-flight-re-analysis-2026-08-11.md`, before any sitting. The
body above is unchanged, because a prediction that gets edited is not a prediction.

The re-analysis showed throughput rising with size from 30 to 330 chunks. **It stops there.** The
fragment sittings measured delivery beyond that point too, and it collapses:

| object | delivered | note |
| --- | --- | --- |
| <= 500 KB | **20/20** | |
| 1.3 MB | 3/5 | the best was 3.9s, which is 336 KB/s |
| 2.5 MB | 1/5 | the one success took **132s** |
| **3.5 MB** | ⛔ **0/5** | all at weeb-3's own 240s ceiling |

⛔ **abel-1's segments are 4.14 MB, past the end of that table.** The one time a 3.5 MB object did
arrive on a healthier node it took **48.8s**, which is 73 KB/s. Four of those in parallel is ~345 KB/s
against a 1,018 KB/s demand, a ratio of **0.34**.

⭐ So the chunk reading and the delivery reading now bracket abel-1 from both sides: throughput
improves with size right up to ~1.3 MB and then the node stops coping, and abel-1 sits beyond the
collapse. **This moves my expectation toward DOES NOT SUSTAIN**, and it makes a sustaining result more
informative rather than less, because almost nothing in our own corpus predicts it.

⭐⭐ **And it promotes content replication from a footnote to the leading explanation.** Our large
references were bench fixtures uploaded once. abel-1 is a working stream someone actually watches. If
it sustains where our 3.5 MB fixtures returned 0/5, the difference is far more likely to be how well
the chunks are spread through the network than anything about size or the node. That is a question we
have never asked and could answer cheaply, by timing retrieval of one of Abel's segments against one
of ours, same node, same minute.

## ⚠️ Confounds this run does not control

- **Content replication.** Abel's segments may simply be better seeded than references we uploaded for
  a bench. Nothing in this design separates that from a size effect, and if the answer lands between
  the two models this is the first thing to suspect.
- **abel-1 is a different recording, not just a different size.** Codec, resolution and how it was
  uploaded all differ from ours.
- **n=1**, as every sitting that costs a human twelve minutes is. `abel-2` is in the harness as a
  replicate, though its segment shape is assumed from abel-1 rather than read.
- **Peers.** If the table comes up short of ~130 the run measures a weak node. `peersAtStart` is
  reported and is read before the ratio, not after.

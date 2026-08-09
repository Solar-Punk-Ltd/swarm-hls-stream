# Seeking a long recording, and the claim a third run took away

**2026-08-09.** Phase 1.2's first unreached question: does a viewer seek across a discontinuity?
**Answer: yes.** And getting there produced a claim that survived one matched pair and died to the
replication, which is the more useful half of this document.

## ⛔ It was never a harness gap

The roadmap blamed the harness: *"still unreached, and both need a longer recording than 27 seconds:
seeking past a discontinuity, and seeking into a region whose chunks have left the local gateway."*

`browser:vod` already seeks to 50%, then 90%, then **back** to 20% of the duration, so it crosses
anything in the middle in both directions. ⭐ **What was missing is the artifact.** Every recording this
project had was 27 seconds, which fits inside the player's buffer whole, so the harness asked both
questions and the player answered neither: nothing had to be retrieved during a seek because everything
was already held.

`pnpm make:recording` makes the artifact: publish, take the writer's bee node away for longer than the
uploader's retry window so a discontinuity is armed mid-recording, publish for as long again, stop
cleanly into a VOD. `RECORDING_ARM_DISCONTINUITY=0` makes the same recording without the outage.

## The three runs

| run | arm | duration | source buffers the player built | appends | seeks landed |
| --- | --- | ---: | --- | ---: | --- |
| 08:22 | discontinuity | 209.03s | **`audio`, `audio`, `audio`** | 18, 208 KB | **0 of 3** ⛔ |
| 08:45 | **control**, none | 195.83s | `audio`+`video` ×3 | 55, 27.07 MB | 3 of 3 ✅ |
| 08:50 | discontinuity | 191.10s | `audio`+`video` ×1 | 52, 27.08 MB | **3 of 3** ✅ |

✅ **A viewer seeks across a discontinuity.** 550ms, 264ms and 940ms to land, 341-350ms to resume,
including the backwards seek. That is Phase 1.2's question answered.

## ⛔⛔ The claim the third run killed

After the first two runs the table read *0 of 3 with a discontinuity, 3 of 3 without*, on a matched
control of the same length from the same producer with one variable between them. **The write-up was
finished and said "a recording containing a discontinuity cannot be seeked."** It was wrong.

⭐ **A matched control is not a replicate.** The control removed the variable I was thinking about; it
could not tell me the failing arm was reproducible, and it was not. The effect being **total** (0 of 3
against 3 of 3) is what made it feel safe to publish off one pair, and total effects are exactly as
capable of being a one-off as marginal ones.

## What is actually there, and it is worth more than the retracted claim

⛔ **Playback of a ~200 second recording intermittently fails outright: 1 run in 3.** When it fails, the
player has built **three audio SourceBuffers and no video SourceBuffer at all**, so hls.js raises
`Attempting to append to the video SourceBuffer, but it does not exist`, goes fatal, and the media
element carries `PIPELINE_ERROR_DECODE` on an audio packet. It appended 208 KB where the healthy runs
appended 27 MB, and held 11.7 seconds of a 209 second recording.

⚠️ **Not a seek defect.** Every seek failed because there was nothing to seek in. The failure is at
load, and the seeks are just where the harness noticed.

⭐ **The restart count varies and is not the cause either**: the healthy runs built one and three buffer
sets, the failing run three. `SwarmHlsPlayer.restartStream()` answering a fatal error is ordinary here.
What is not ordinary is coming back **without a video buffer**.

⬅ **Open**: what makes the video track absent on init. One occurrence, so the mechanism is unmeasured
and no fix should be designed against it yet. Cheapest next step is repetition, since each run is a few
hundredths of a BZZ and the base rate is what decides whether this matters.

## ⭐ Error text is not the discriminator, and this nearly cost a second wrong claim

All three runs log the same family of `bufferAppendError` and `InvalidStateError` warnings. **The
control throws them and seeks perfectly.** A check written against the error text would have condemned
every arm and found nothing.

What separated them was one structural fact, visible only by asking the player what it had built rather
than reading what it complained about: **which SourceBuffers exist.** That is why the harness records
them.

## What this does not say

⚠️ **Phase 1.2's second question is still unanswered.** Seeking into a region whose chunks have *left
the local gateway* needs a gateway that evicted them, and `--cache-capacity` is 0 on this deployment, so
nothing is cached to evict. The seeks above all retrieved from the network, which is the interesting
half, but none met a chunk that could not be retrieved at all.

⚠️ Scope: SRS, 720p, a 2s GOP from the e2e publisher, one viewer, gateway one hop from the uploader.

## Cost

Three recordings at about three minutes of 720p publishing each, plus three browser playbacks. A few
hundredths of a BZZ in total, and postage did not move.

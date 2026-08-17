# The decay cohort: does reading content keep it alive?

**Seeded 2026-08-11 from a broadcast whose content was verified healthy the same hour** (8/8, see
`fresh-vs-decayed-2026-08-11.md`). Costs nothing to run and nothing to maintain.

## The question

Content we uploaded on 2026-08-03 went from retrievable, to 2/10, to 0/8 over about a week, while its
postage stayed `usable`. Nobody knows whether that is age alone or **absence of reads**. The
difference decides the product:

- **Age alone** → a video product on Swarm needs re-upload on a timer, for everything, forever.
- **Reads keep it alive** → popular content is self-sustaining and only the long tail needs help.

## The design

Today's broadcast produced 629 segments. `decay-cohort-2026-08-11.json` holds 505 of them, trimmed at
both ends. They are split by index parity into two arms of the same age, the same size, the same
upload, the same postage batch and the same broadcast:

| arm | what happens to it |
| --- | --- |
| **read** | fetched every day |
| **untouched** | **never fetched until the read arm shows decay**, then once |

⭐ **The two arms differ in exactly one thing: whether anybody reads them.** Everything a corpus
comparison normally confounds is held constant by construction, because both arms are the same
broadcast.

⛔ **Do not fetch the untouched arm to "check on it".** Every read of it is the treatment being
applied to the control, and it cannot be undone. That is why it is not in the daily plan file at all.

## Running the daily read

```bash
node deploy/scripts/corpus-delivery.mjs docs/bench/decay-cohort-daily-2026-08-11.json docs/bench/decay-$(date -u +%Y-%m-%dT%H%M).json
```

The control arm is **his** content, so a bad day for the node is distinguishable from a bad day for
ours. A round where the control fails means the node, not the corpus.

## Reading the result

The read arm falling while the untouched arm holds would be surprising and would mean something other
than reads is at work. The interesting outcomes are:

- **both fall together** → age, not reads. Re-upload on a timer.
- **untouched falls first** → reads keep content alive.
- **neither falls in two weeks** → the aug03 corpus died of something specific to it, and the whole
  decay reading needs re-opening. ⚠️ That is a real possibility and the reason the cohort exists
  rather than another round of argument.

## The log

Every daily read goes here, so the series is one table rather than a directory of files to diff.

⛔⛔ **THE HOUR COLUMN WAS WRONG ON EVERY ROW UNTIL 2026-08-13, and it was wrong in the direction
that flatters the result.** The first two rows were labelled 24h and 48h from their calendar dates.
The cohort was seeded at **2026-08-11T15:48Z** and those reads ran at 01:53Z and 01:54Z, so they were
taken at **10.1h and 34.1h**. A read is a calendar day after the one before it and that is not the
same as a day after the seed. Elapsed hours below are computed from the seed, and a date alone is not
enough to place a row.

| read | taken (UTC) | age | **read arm** | KB/s | control `his` | its ref set | KB/s | `ours-aug03` |
| ---: | --- | ---: | ---: | ---: | ---: | :-: | ---: | ---: |
| 1 | 2026-08-12T01:53Z | **10.1h** | **8/8** | 459 | 8/8 | **A** | 1154 | 0/8 |
| 2 | 2026-08-13T01:54Z | **34.1h** | **8/8** | 416 | 8/8 | ⚠️ B | 911 | 0/8 |
| 3 | 2026-08-13T17:06Z | **49.3h** | **8/8** | 490 | 8/8 | ⚠️ C | 1218 | 0/8 |
| 4 | 2026-08-14T03:56Z | **60.1h** | **8/8** | 478 | 8/8 | **A** | 1259 | 0/8 |
| 5 | 2026-08-15T11:13Z | **91.4h** | **8/8** | 362 | 8/8 | **A** | 1101 | 0/8 |
| 6 | 2026-08-16T08:38Z | **113.1h** | **8/8** | 470 | 8/8 | **A** | 1121 | 0/8 |
| 7 | 2026-08-17T05:43Z | **133.9h** | **8/8** | 488 | 8/8 | **A** | 1287 | 0/8 |

⛔⛔ **THE CONTROL'S REFERENCE SET MOVES AND THE READ ARM'S DOES NOT.** The read arm is a fixed
`refs` list, so all six reads fetch the same eight objects at 795 KB. The control is a **live feed**,
harvested at read time, so it picks up whatever his broadcast is publishing that hour. Three distinct
sets appear across the six reads, at means of 4,214 (A), 3,873 (B) and 4,296 KB (C).

⭐ **That is correct for the job the control does** and wrong for the job it is easy to give it. It
answers "is the node answering right now", which needs fresh content and does not care which. It
cannot answer "is the node slower today than yesterday" unless two reads happen to share a set.
⚠️ **Only reads 1, 4, 5 and 6 are comparable to each other on the control's rate column.**

**Nothing has decayed by 133.9 hours.** At read 7 the read arm delivered 8/8 at a mean 795 KB and
488 KB/s, the control delivered 8/8 at 4,214 KB and 1,287 KB/s, and `ours-aug03` returned 503 on all
eight. Seven reads, no object lost by either arm.

⭐ **Read 7 is the fastest set-A round on both arms**, read arm 488 against a previous set-A best of
478, control 1,287 against 1,259. **They moved together and up**, which is a good hour for the node
and not a statement about the corpus. Its control set was verified reference by reference against
read 6, all eight identical, rather than inferred from the 4,214 KB mean.

⚠️ **Both arms slowed on read 5 and neither lost an object.** The read arm went 478 to 362 KB/s and
the control went 1,259 to 1,101 KB/s, so the read arm fell further in proportion, 24% against 13%.
✅ Reads 4, 5 and 6 share control set A, verified reference by reference from the artefacts and not
from the mean size alone, so those three are a like-for-like comparison on the rate column.

✅ **Read 6 settles it: the dip did not continue.** The read arm went 362 back to 470 KB/s, inside
the 416 to 490 band of reads 1 through 4, and the control went 1,101 to 1,121. The paragraph above
was written saying a rate that keeps falling while delivery holds would be the first sign of
anything. **It did not keep falling**, so read 5 was noise on eight fetches and nothing more.

⭐ That is the value of writing down a reading nobody could interpret yet. A single low round is
either the start of something or it is nothing, and only the next row can say which.

⚠️ **The read arm's mean size is 795 KB on every read**, because the stride picks the same references
from a fixed list every time. ⛔ **This paragraph used to say the same of the control at 4,214 KB
across reads 3, 4 and 5, and that is wrong: read 3's control was a different set at 4,296 KB.** See
the ref-set column above.

⛔ **This read needs Chrome and the deployment host has none**, so it runs from the Mac. The command
below defaults `CHROME_PATH` to a macOS path, which is why. Running it on the host fails with
`spawn /Applications/Google Chrome.app/... ENOENT`, and the cohort plan files are not in the bench
checkout either.

⚠️ **The untouched arm is deliberately absent from this table**, because reading it to fill a column
is the treatment being applied to the control. It gets read once, after the read arm shows decay.

⭐ `ours-aug03` returning 503 on all eight every day is doing useful work as a second control: it
shows the harness can still tell a dead object from a live one, so an 8/8 on the read arm is a
positive reading rather than a check that passes for everything.

⛔⛔ **READ 6 IS AT 113.1h AND IS NOT THE 120h READ, THOUGH IT WAS RUN EXPECTING TO BE.** The window
opens at **2026-08-16T15:48Z** and this read was taken at 08:38Z, seven hours short of it. Nothing
about the result changes, but the label would have, and mislabelling a row by a calendar assumption
is the exact defect that made rows 1 and 2 wrong. **Compute the elapsed hours, every time.**

⚠️ **The window is not one read, and 120h is where it opens rather than where the answer is.** The
aug03 corpus was still partly retrievable at about a week and dead by nine days, so the reads that
can actually separate the outcomes are **~168h (2026-08-18T15:48Z)** and **~216h (2026-08-20T15:48Z)**.
A clean 8/8 today rules out early decay and nothing else.

⭐ **Six clean reads across 113 hours is itself worth stating**, because the untouched arm has to
stay untouched until the read arm moves, and every day it does not move is a day that decision holds.

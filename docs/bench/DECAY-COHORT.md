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

| read | taken (UTC) | age | **read arm** | control `his` | `ours-aug03` |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 2026-08-12T01:53Z | **10.1h** | **8/8** | 8/8 | 0/8 |
| 2 | 2026-08-13T01:54Z | **34.1h** | **8/8** | 8/8 | 0/8 |
| 3 | 2026-08-13T17:06Z | **49.3h** | **8/8** | 8/8 | 0/8 |

**Nothing has decayed by 49.3 hours.** The read arm delivered 8/8 at a mean 795 KB and 490 KB/s, the
control delivered 8/8 at 4,296 KB and 1,218 KB/s, and `ours-aug03` returned 503 on all eight.

⚠️ **The untouched arm is deliberately absent from this table**, because reading it to fill a column
is the treatment being applied to the control. It gets read once, after the read arm shows decay.

⭐ `ours-aug03` returning 503 on all eight every day is doing useful work as a second control: it
shows the harness can still tell a dead object from a live one, so an 8/8 on the read arm is a
positive reading rather than a check that passes for everything.

⚠️ **Two days is not yet informative about the interesting outcome.** The aug03 corpus was still
partly retrievable at a week and dead by nine days, so the window that matters starts around **120
hours from the seed**, which is 2026-08-16. ⛔ Stated in hours rather than in "day 5" on purpose:
counting days is what put the two wrong labels in the table above.

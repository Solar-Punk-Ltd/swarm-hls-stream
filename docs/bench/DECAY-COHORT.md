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
node deploy/scripts/corpus-delivery.mjs docs/bench/decay-cohort-daily-2026-08-11.json docs/bench/decay-$(date -u +%Y-%m-%d).json
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

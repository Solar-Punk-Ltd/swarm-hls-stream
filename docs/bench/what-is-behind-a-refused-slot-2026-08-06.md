# What is behind a refused slot

**2026-08-06.** Probe: [`feed-ahead-probe.mjs`](../../e2e/src/probes/feed-ahead-probe.mjs), run beside a
0.25s-GOP broadcast while `latbench-stream-uploader-1` was killed for 15s. Settles task #71, which
had been argued from a run that could not answer it.

## The question the viewer's own log could not answer

The uploader-crash run on 2026-08-05 showed a viewer ask slot **301** one hundred and thirteen times
over sixty seconds, get served at last, and then take slots 302 to 570 in twelve seconds. That burst
has two readings and they call for opposite fixes:

- **302 onward were retrievable the whole time** and the reader was blind to them. Worth about 44
  seconds, and task #71 is worth building.
- **Nothing was retrievable until the moment everything was.** The reader was correctly waiting,
  there was nothing to find, and a probe would cost a request per poll and return nothing.

**The client's request log cannot separate them.** A walk that stops at its first 404 never asks past
it, and the log contains **zero** requests for slot 302 during the whole stall. The reading had to
come from an instrument that asks anyway.

## The answer

| | |
| --- | ---: |
| polls | 106 |
| slots read | 554 |
| slots refused | 76 |
| **refusals with a served slot behind them** | **74** |
| refusals with nothing behind them, a true head | **2** |
| **worst stall** | **slot 190, 65 consecutive polls, 19.1s** |
| of those 65 polls, ones with a served slot behind | **65** |

⭐ **A refused slot at the live edge is almost never the head of the feed.** Seventy-four of
seventy-six refusals had already-retrievable slots behind them. The two that did not are the case the
404 is designed to mean.

Slot 190 is the finding in one line. For **sixty-five consecutive polls over nineteen seconds** it
answered 404, and on **every one of those polls** all six probes behind it, at +1, +2, +4, +8, +16 and
+32, were served. The reader was one request away from moving the whole time.

## How far behind to look

| nearest served distance | holes |
| --- | ---: |
| **+1** | **73** |
| +8 | 1 |

**One extra request finds 73 of 74.** The exception was slot 189, where +1, +2 and +4 were all
refused and only +8 answered, which is a hole several slots wide rather than one. It cleared on its
own in three polls.

So a probe should ask +1 first and stop there when it answers, which is almost always. A short ladder
past it costs nothing in the common case and covers the wide hole.

## When it happens

| phase | stalled slots | worst |
| --- | ---: | ---: |
| before the kill | 2 | 3 polls |
| while the uploader was down | 0 | — |
| after it came back | 8 | **65 polls** |

**The stall follows the restart, not the outage**, which is what the browser run saw too: the viewer
there waited 46.7s *after* the service was healthy again. Nothing is written while the uploader is
down, so there is nothing to be blind to. The damage starts when it resumes.

## ⚠️ The instrument was wrong first, and read as a result

The first version of this probe took **one slot per poll**. It read 3.34 slots a second against a
publisher writing 3.75, so it lost ground continuously and was never at the live edge. Its report:
`longest run of polls stuck on one slot: 3`, on a run where the uploader was killed for fifteen
seconds. Every 404 it met was a moment it had briefly caught up.

**That is task #84's defect, in the instrument rather than the product**, found the day after it was
fixed in the client. An instrument that cannot reach the edge cannot measure what happens there, and
this one printed a calm number instead of failing. It now walks to the head as the client does.

## What this does and does not settle

**Settled: the premise of task #71.** A refused slot routinely hides retrievable slots, the worst
observed stall was 19.1 seconds with something at +1 on every poll of it, and one extra request
finds them.

**Not settled: why a slot is slow.** The chunk is committed by the uploader and accepted locally
before the feed advances, so what varies is when the gateway can retrieve it. That is worth its own
investigation and does not change the client's remedy, which holds whatever the cause: the reader
should not be blind to work that is already done.

**One run.** The 19.1s stall is one observation, and the browser run's 46.7s is another of the same
shape. Neither has been repeated.

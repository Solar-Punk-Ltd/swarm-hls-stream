# The overlay is silent for the first freeze and loud for the second, and the difference is not the fault

**2026-08-07.** Task #100. Answered from the recorded runs rather than from a fresh broadcast, which
turned out to be better than the single run the task asked for: two independent uploader crashes
disagreed, and having both is what makes the answer decidable.

## The two reports do not disagree about the product

Both crashed the uploader at **t+52s** under a watching viewer. Both left the picture frozen. One
told the viewer something and one said nothing at all.

| run | freeze | feed polls inside it | overlay |
| --- | ---: | ---: | --- |
| `uploader-crash` 2026-08-05 17:11 | **54.9s** | 108 | spoke, **14.4s in** |
| `uploader-crash` 2026-08-06 04:41 | **12.4s** | 13 | **never** |

`FeedStateOverlay` calls a feed stalled after `UNSERVED_SLOT_POLL_LIMIT = 30` consecutive polls land
on an unserved slot. The 08-05 freeze reached that count 14.4 seconds in, at the 2.0 polls per second
it was managing. The 08-06 freeze ended after 13 polls and never came close.

So the product behaved identically in both. **The threshold simply sits between the two freezes**, and
the reports differ because the freezes did. Nothing needs reconciling and nothing is intermittent.

## What the run does show is worse than the disagreement

The threshold is counted in polls. The poll rate is not a constant, and it does not vary randomly: it
**collapses during exactly the fault the threshold exists to detect.**

Measured inside the 08-06 run, feed reads before the crash against feed reads during the freeze:

| | polls | median duration | median gap between starts | status |
| --- | ---: | ---: | ---: | --- |
| before the freeze | 189 | 260ms | 264ms | 178x 200, 10x 404 |
| inside the freeze | 13 | **744ms** | **1064ms** | **12x 404**, 1x 200 |

Both halves move the same way. Each read takes about three times as long, and the client spaces the
reads about four times wider because the slot is unserved. Together the rate falls by roughly four.

What 30 polls is worth in seconds, therefore:

- **about 8 seconds** while the stream is healthy, at a 264ms poll gap
- **about 32 seconds** during a stall, at a 1064ms poll gap

Across four recorded crash runs the healthy-state rate ranged 3.48 to 5.25 polls per second, so the
healthy figure is 6 to 9 seconds. The stalled figure is where the spread matters, and the two
uploader crashes measured 1.1 and 2.0 polls per second inside their freezes, which is 15s and 27s for
the same constant.

**The delay before a viewer is told anything is not a designed quantity.** It is whatever the poll
rate happens to be, and the poll rate is worst when the viewer most needs telling.

## What this does and does not settle

It settles #100: the overlay was not broken on 08-06, and the two reports are consistent.

It does not settle what the threshold should be, and that is deliberately left open. The constant's
own comment says it was chosen against how long a viewer will sit through a frozen picture, which is
a fact about viewers and not about arithmetic. This run says the constant cannot express that fact
in its current unit, because the conversion moves by four under load.

**The recommendation, which is a product call and not made here:** denominate the threshold in
elapsed milliseconds on the unserved slot rather than in polls, and keep whatever number of seconds
the current behaviour is judged to have got right. That makes the delay a decision instead of a
by-product, and it removes the case measured above, where a 12.4 second dead picture passes without a
word because the fault also slowed the polling that would have reported it.

Nothing was changed in the client for this. `UNSERVED_SLOT_POLL_LIMIT` still reads 30 and the overlay
still behaves exactly as both runs recorded.

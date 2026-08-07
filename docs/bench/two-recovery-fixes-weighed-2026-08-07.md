# Two recovery fixes weighed, and only one of them moved

**2026-08-07.** Phase 0.5d asked for fix 0.8a and fix 0.8b before and after, naming **46.7s and 16.2s**
as the numbers to move. Both are already measured. **No new broadcast was needed to answer this**, and
the two answers are not alike.

⛔ **The obvious comparison for 0.8b is wrong by more than double.** Reading the newest report against
the oldest gives 16.2s to 10.7s, which looks like 5.5 seconds bought. Those two figures are on
different clocks. The real figure is about 2.4s, and it is not established.

## Fix 0.8a, probing past a hole: decisive

Scenario `uploader-crash`, and both runs measure the same thing the same way.

| | before | after |
| --- | ---: | ---: |
| run | `browser-crash-uploader-crash-2026-08-05T17-11-11-039Z` | `…2026-08-06T04-41-37-300Z` |
| **it moved again, after the service returned** | **46.7s** | **4.1s** |

✅ **Target met.** #71 set "under 5s" and it came in at 4.1s. The freeze was 54.9s of which 46.7s was
after the uploader was healthy, and the walk had asked for one slot address 112 times without passing
it. One extra probe request removed 42.6 seconds of frozen picture.

## Fix 0.8b, noticing the gateway is back: not established

Scenario `viewer-gateway-outage`, and here the instrument changed **between the before and the after**.
`169ce9e` and `738d9fd` stopped charging the client for the gateway's own startup, so the newer reports
start their clock when the service *answers* rather than when `docker start` returns.

| run | fix 0.8b | clock the report uses | figure | gateway startup | **on the docker clock** |
| --- | --- | --- | ---: | ---: | ---: |
| 08-05 17:05 | before | docker returned | 16.2s | not measured | **16.2s** |
| 08-06 04:46 | after | docker returned | 14.1s | not measured | **14.1s** |
| 08-06 05:06 | after | service answered | 12.2s | 0.9s | **13.1s** |
| 08-06 05:13 | after | service answered | 10.7s | 3.5s | **14.2s** |

**Restated on one clock: 16.2s before, and 14.1, 13.1, 14.2 after.** About **2.4 seconds**, from one
run before against three after.

⚠️ **That is not distinguishable from noise.** The three after-runs spread 1.1s among themselves inside
one sitting, and the before-run is a different sitting, where `between-session-drift.md` measured 1.05s
of movement on exactly the read-side hops this scenario exercises. A 2.4s difference against a 1.1s
within-sitting spread, with n=1 on the before, is suggestive and no more.

**This is not a surprise and #91 predicted it.** Most of what remains is the gateway becoming able to
serve content plus the client refilling its buffer, neither of which any client change reaches. The
task's "under 3s" target was never achievable, because 7.2s of the original 14.1s belonged to the
service starting up.

## What this settles for the campaign

**0.5d is answered and does not need its 50 minutes.**

- **0.8a is worth 42.6 seconds of frozen picture** at a viewer, measured the same way on both sides.
- **0.8b's effect is not established**, and a further before-run would have to be produced by reverting
  a shipped fix, which is not worth 50 minutes of broadcast for a quantity #91 already showed is mostly
  not ours.

⭐ **The lesson is about the campaign rather than the client.** An instrument was corrected in the
middle of a before-and-after, which is the right thing to do to an instrument and the worst possible
time to do it to a comparison. The before was never re-measured on the new clock, so the pair can only
be read on the old one, and the newest and most accurate figures are the ones that cannot be used for
the comparison the campaign asked for. **When a fix and its instrument change in the same round, the
before has to be re-run or the comparison is spent.**

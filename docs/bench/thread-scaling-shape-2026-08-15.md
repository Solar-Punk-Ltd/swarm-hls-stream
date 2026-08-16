# The main thread's distribution scales uniformly, and two claims that did not survive being checked

> ## ⛔⛔⛔ WHAT THE CLIENT UNDER TEST ACTUALLY WAS, AND WHO CHOSE IT
>
> The `weeb3` arms here fetch **segment bytes only** from the in-tab node. The feed and every
> manifest still come from a **bee gateway**, in both conditions. Verified in source: `ManifestManagement`
> has no weeb-3 path, only `CustomManifestLoader` does.
>
> That split was my design decision in PR #183 and **nobody authorised it**. The owner's instruction
> of **2026-08-11T07:07Z** was *"Abel optimized the player as much as possible let's measure and
> experiment with his setup as it is"*, and this is not that.
>
> ⛔ **So any residual gateway load reported below is a floor THIS CLIENT imposes, not one weeb-3
> imposes.** Abel's own live page drives it to zero, proved free on 2026-08-16. Every saving figure
> here is a **lower bound** on what an in-tab node can do.
>
> ✅ **The arithmetic and the arm-to-arm contrasts are unaffected.** Both conditions read the
> manifest the same way, so the comparison is clean. What is limited is the **subject**, not the sums.
>
> See [`abel-gateway-less-live-2026-08-16.md`](abel-gateway-less-live-2026-08-16.md).

No broadcast, no BZZ. Every number here comes from the **eleven** counted arms already recorded by
`main-thread-saturation-2026-08-14.md` (six) and `1080p-main-thread-2026-08-15.md` (six, of which
**one was refused by the axis guard** for not being delivered at 1920x1080 30fps), plus the
forty-minute arms of `long-arm-drift-2026-08-14.md` for the median table in the last section.

⛔ **This line said "fourteen" and no combination of the sources reaches fourteen.** Six and six is
twelve, and the axis guard this document says it honours takes one of those away.

Written because the next thing on the list was a third resolution at about 1.5 BZZ, bought to draw a
better line through the peak. The 1080p sitting had just refuted a line drawn through two peaks, and
the peak is one order statistic off a distribution of eighty-five windows per arm. The distribution
was already paid for.

## What the sittings actually contain

`read-sitting.py shape` pools every five-second interval of every counted arm, per condition, and
prints the count standing behind each quantile.

    weeb3    720p n=253   1080p n=253
      quantile     720p    1080p    ratio   samples above
         0.250    0.206    0.337    1.64x       190
         0.500    0.217    0.353    1.62x       127
         0.750    0.228    0.367    1.61x        64
         0.900    0.245    0.390    1.60x        26
         0.950    0.271    0.408    1.50x        13  <-- thin
         0.975    0.374    0.465    1.24x         7  <-- thin
         0.990    0.545    0.559    1.03x         3  <-- thin

    gateway  720p n=254   1080p n=169
         0.250    0.067    0.082    1.23x       127
         0.500    0.071    0.088    1.24x        85
         0.750    0.076    0.093    1.22x        43
         0.900    0.081    0.099    1.22x        17  <-- thin

## The finding

**Every quantile backed by real counts moves by one factor.** The in-tab path scales **1.60x to
1.64x** from q25 to q90 against **2.40x the bytes**. The gateway path scales **1.22x to 1.24x** over
the same range.

The distribution does not change shape. It is multiplied. p90/p50 reads **1.129 at 720p and 1.105 at
1080p**, which is the same distribution at a different size.

That makes the exponent the whole description:

| path | scaling over 2.40x bytes | exponent |
| --- | ---: | ---: |
| in-tab (weeb3) | 1.61x | **0.55** |
| gateway | 1.23x | **0.23** |

⭐ **Both are sub-linear, and the in-tab path's is near a square root.** A viewer's main thread does
not pay proportionally for bitrate on either path.

⚠️ **Two points fix an exponent and do not test it.** What a third resolution buys is a test of 0.55,
not another peak. That is a different purchase from the one this document was written instead of.

## ⛔⛔⛔ TWO CLAIMS THAT DIED ON INSPECTION, BOTH MINE, BOTH FROM TONIGHT

### 1. "The tail is invariant to bitrate"

p99 moved **1.03x** while p90 moved 1.60x. Read alone that says the tail is a fixed-cost event the
bitrate does not touch, and since both sittings ran the same 0.5s GOP, playlist re-parse was the
obvious candidate: it is priced per segment count, and segment count per second is identical at both
bitrates.

**With 253 pooled intervals, p99 is the third-highest value.** The invariance is three windows. The
gateway side rests on two. It is not a finding and there is no tail effect to explain.

### 2. "The crest factor is compressing"

Mean 0.225 to 0.357 is 1.59x while max 0.600 to 0.707 is 1.18x, so peak-over-mean falls from 2.67 to
1.98 and the headroom between typical and worst appears to be closing. **Both ends of that ratio are
extremes.** Against robust statistics, p90/p50 is 1.129 and 1.105. Nothing compressed.

⭐ **Both claims came from comparing an order statistic with a bulk one.** A mean is backed by every
sample and a max by one, so any ratio between them is mostly a statement about the sample size.

## ⛔ AND THE MECHANISM THOSE CLAIMS IMPLIED IS REFUTED SEPARATELY

If the tail were playlist work, the within-session creep would have to live there too: the manifest
never trims, so every refresh re-parses a longer list while decoding a segment costs what it always
did. The forty-minute arms say the opposite.

| arm | q50 per window | slope | q95 per window | slope |
| --- | --- | ---: | --- | ---: |
| weeb3 | 0.212 0.218 0.227 0.227 0.225 0.235 | **+0.034** | 0.325 0.246 0.377 0.256 0.278 0.270 | -0.076 |
| weeb3 | 0.215 0.226 0.230 0.229 0.239 0.236 | **+0.037** | 0.278 0.261 0.277 0.259 0.292 0.265 | +0.003 |
| gateway | 0.071 0.079 0.083 0.090 0.096 0.100 | **+0.051** | 0.080 0.092 0.096 0.104 0.107 0.119 | +0.063 |
| gateway | 0.072 0.079 0.083 0.091 0.093 0.098 | **+0.045** | 0.085 0.091 0.096 0.115 0.110 0.123 | +0.066 |

**The in-tab creep is in the median**, monotonic in both arms, while its q95 is noise. ⭐ The creep
`long-arm-drift-2026-08-14.md` measured is the whole distribution sliding, not a tail growing, and it
remains unexplained.

> ### ⛔⛔ CORRECTED 2026-08-15: THE ARGUMENT HERE WAS WRONG, THOUGH THE CONCLUSION HOLDS
>
> This paragraph read "**No manifest can make the typical window slower**", arguing that manifest work
> could only live in the tail. `manifest-growth-2026-08-12.md` measured the opposite property of the
> same code path: `serialize` rebuilds the whole string whenever the state is dirty, **a poll that
> finds a new segment sets dirty, and a viewer at the live edge finds one on nearly every poll**. Its
> control separates 10.97-12.27 ms per dirty poll from 0.0019 ms per clean one. **Manifest work is
> paid in the typical window, not the tail.**
>
> ⭐ **Replace the location argument with a magnitude one, which is stronger.** At a 0.5s GOP a viewer
> holds 1,800 segments after 15 minutes and 21,600 after three hours. Interpolating
> `manifest-growth`'s cost table and paying it about twice a second:

| into a 3-hour arm | segments held | rebuild | manifest CPU |
| --- | ---: | ---: | ---: |
| 15 min | 1,800 | 0.21 ms | 0.0004 cores |
| 3 h | 21,600 | 2.81 ms | **0.0056 cores** |

> **That is +0.0018 cores/hr against a measured +0.0357 cores/hr, so the manifest can account for
> about 5% of the creep and is roughly 20x too small to be it.**
>
> ⚠️ **An order-of-magnitude argument, not a measurement.** `manifest-growth` timed a synthetic fill
> on a laptop rather than the rebuild inside the tab, and the poll rate is assumed at one per segment.
> Both could be wrong by a factor of two or three without changing the conclusion, and neither could
> be wrong by twenty.

⚠️ The gateway path creeps in both, so this separates the two conditions rather than settling either.

## What the tool now refuses to let anyone repeat

`read-sitting.py shape` prints the sample count beside every ratio and marks any quantile with fewer
than twenty samples above the cut. The thin rows are printed rather than hidden, because a reader who
cannot see p99 will compute it by hand from the same file.

It also drops arms the axis guard refused and says which. Before that, `shape` pooled 254 gateway
intervals from a sitting where `table` had already refused one of the arms that produced them. **Two
views of one sitting disagreeing about its own membership** is how a figure from a discarded arm ends
up beside one from a kept arm. An arm that failed the profile is dropped, an arm nobody could check is
kept and named, because dropping every unverifiable arm would leave an older sitting with no
distribution and no explanation.

## What this changes about the next purchase

The three-hour arm was priced at ~3.3 BZZ **in the shape of the last sitting**, alternating both
conditions. The question it answers is about the in-tab path's own creep, and #104 already established
that both paths creep, so it needs **one long in-tab arm and no gateway arm**.

| | modelled | measured |
| --- | ---: | ---: |
| uploader, per broadcast hour | 0.78 | 0.77 |
| gateway, per broadcast hour, **on an in-tab arm** | 0.64 | **0.01** |

**Three hours costs about 2.34 BZZ rather than 3.3.** ⚠️ The spend gate still projects it at the
modelled gateway rate, because it cannot know in advance that no arm will ask the gateway for
segments, so it demands headroom for **4.27** and refuses anything under a **14.0** ceiling. That
conservatism is correct and it is not something to override: a gate whose inputs are lowered to fit a
plan is not a gate.

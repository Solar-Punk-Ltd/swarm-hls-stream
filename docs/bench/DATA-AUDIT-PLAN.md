# Auditing, tagging and cleaning the bench corpus

**2026-08-11.** Written after a result measured on a bench-only stream profile was reported as if it
were the product, and an in-browser result was compared against a gateway-based one. Both were mixing
errors rather than measurement errors. This plan is about making that class impossible.

⚠️ **This is a plan. Nothing here has been executed.**

## 1. What we have

652 files in `docs/bench`: roughly 540 raw run artifacts and 60 named analysis documents.

| family | n | records its own config? |
| --- | ---: | --- |
| `latency-*` | 175 | ✅ `engine`, `profile`, `knobs{fps, gopSeconds, videoBitrateKbps, size}` |
| `longrun-*` | 165 | ✅ same |
| `browser-watch-*` | 159 | ⚠️ `gopSeconds` and `chromeVersion` only |
| `browser-vod-*` | 39 | ⛔ nothing but `watchUrl` |
| `browser-crash-*` | ~30 | ⛔ scenario name only |
| `in-browser-*` | 15 | ⚠️ prose header, not machine readable |
| named analysis docs | ~60 | prose |

## 2. ⛔⛔ THE ROOT CAUSE, IN ONE LINE

**The corpus tags the ENCODER axes and not the RETRIEVAL axes.** `gopSeconds`, `videoBitrateKbps`,
`fps` and `size` are recorded on 340 files. **Which node served the bytes, whether it was funded,
whether its cache was on, and whether a gateway was in the path at all are recorded nowhere except
prose.** Those are exactly the axes whose results contradict each other, so they are exactly the axes
a reader has to reconstruct by hand, and that reconstruction is where every mixing error came from.

## 3. The tagging schema

Every result, old or new, gets these. A result missing any of them cannot be quoted, only cited as
provisional.

**A. Retrieval architecture** — the axis I collapsed
- `A1-gateway` browser or probe reads over HTTP from a bee node
- `A2-in-browser` weeb-3's own libp2p node in the page, **no gateway in the path**
- `A3-direct` a script reading a bee API on the host, no browser

**B. Serving node mode**
- type: `full` / `light` / `ultra-light`
- funding: `funded` / `unfunded` (chequebook, **not** postage)
- cache: `on` / `off` / `unknown` ⛔ and see the void rule below
- peers: recorded count at the time, plus **tab count** for A2

**C. Stream shape**
- `profile`: **`shipping`** (`HLS_FRAGMENT=1.0`) or **`latbench`** (`HLS_FRAGMENT=0.25`) or `custom`
- segment duration actually observed, GOP, bitrate, resolution, fps
- ⛔ the declared duration is not the observed one before 2026-08-06

**D. Load** — viewers, concurrency requested **and achieved**, arrival pattern
**E. Content state** — `cold` / `warm`, `live` / `vod`
**F. Instrument** — harness file and commit, and **the metric the conclusion is scored on**

## 4. ⛔ Void rules: results that cannot be repaired by re-reading

Applied first, because they delete work rather than reclassify it.

| rule | what it voids |
| --- | --- |
| **V1** cache flag | `--cache-capacity=0` never disabled anything. Every "cache off" arm before the `--cache-retrieval` fix is **void, not merely caveated** |
| **V2** feed head lookup | Every frozen-share figure predating the sequential-lookup fix measures the lookup, not a viewer |
| **V3** declared duration | Any figure derived from a manifest's declared segment duration before 2026-08-06 is stretched 20-25% |
| **V4** tab starvation | Any A2 figure taken with more than one weeb-3 tab open is a contended node |
| **V5** block depth | Any concurrency arm whose block was under ~5x its concurrency is understated; occupancy must be reported |
| **V6** pasted harness | Any in-browser sitting whose script was pasted rather than fetched cannot be tied to a commit |

## 5. ⚠️ Flag rules: results that survive but must be re-scoped

| rule | meaning |
| --- | --- |
| **F1 overreach** | conclusion generalises past its axes. **The largest category.** Example: an A2 result written as "a browser viewer", or a `latbench` result written as "our stream" |
| **F2 wrong metric** | scored on a metric whose optimum is opposite to the question. **Per-fetch delivery success vs playback feasibility is the known instance** and it inverted the fragment-size conclusion |
| **F3 n=1** | provisional until replicated |
| **F4 uncontrolled drift** | node health not sampled through the run, so decay and content cannot be separated |
| **F5 superseded** | a later replicate disagrees; keep both, mark which wins and why |

## 6. Execution order

**Phase 0, free, no measurement.** Write the tags. Machine-extract A/C/D for the 340 `latency-*` and
`longrun-*` files from their own `engine`/`profile`/`knobs`. Hand-tag the ~60 analysis docs, which is
where the quotable claims live. Produce `docs/bench/INDEX.md`: one row per **claim**, not per file,
with its tags, its rule flags, and its status.

**Phase 1, free, re-analysis only.** Apply V1-V6 and F1-F5. ⭐ Much of the corpus is repairable by
re-scoring rather than re-running, because the raw rows were retained. The fragment sweep re-scored on
playback feasibility instead of per-fetch success is the worked example: same data, opposite answer.

**Phase 2, the gap that matters most.** ⛔ **The shipping profile has never been measured on an
in-browser node.** Every A2 sitting used the `latbench` recording. That is not a cleanup, it is a
missing experiment.

**Phase 3.** Re-measure only what Phase 1 cannot repair.

## 7. What to measure, in priority order

| # | measurement | why | cost |
| ---: | --- | --- | --- |
| **1** | **A2 sustain on Abel's 4.17s stream** | a **positive control** we have never had. If it sustains, the harness and node are sound and the profile is the variable | free, needs a human tab |
| **2** | **A2 sustain at the shipping 1.0s profile** | the number we should have had from the start | free if a 1.0s recording exists, else an upload |
| **3** | **A2 segment-duration sweep scored on playback ratio** | the controllable axis, never swept on the right metric | free per arm once content exists |
| **4** | **the player's achieved concurrency** | still inferred from source, never observed. Analyser half already written and tested | free |
| **5** | **A1 vs A2 on identical content, same hour** | the two architectures have never been compared like for like | free |
| **6** | re-run anything V1 voided that still matters | cache claims currently rest on void arms | mostly free |

## 8. Rules that stay after the cleanup

- **Check what ships before choosing test content.** One `grep HLS_FRAGMENT` would have prevented this.
- **The scope goes in the heading**, because the heading is what travels.
- **Name the metric a conclusion is scored on**, since two reasonable metrics can invert an answer.
- **A positive control first.** Measure something known to work before concluding something is broken.

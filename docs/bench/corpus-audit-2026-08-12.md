# What in this directory is still true, 2026-08-12

**691 files.** 340 are raw `json`/`tsv`/`log` captures, 326 are `md` write-ups, the rest are odds and
ends. **Raw captures are never voided here**: a row that records "this reference returned 503 after
11.4s" stays true forever. What gets voided is a *claim*, and claims live in the markdown.

So this is a register of claims, not a file-by-file sweep, and the count that matters is not 691.

## The three contaminations, and how to tell whether a document has one

### A. Corpus decay, affects anything that fetched our own aged content

Swarm stops returning chunks we uploaded while the postage still reports `usable: true`. A sweep whose
arm silently held unretrievable references spent its budget on timeouts.

⭐⭐ **Direction matters and I got it backwards once.** A decayed arm **understates** the node, because
the failures are missing content rather than slow delivery. Every affected throughput figure is a
**floor**, not a ceiling. Confirmed by re-measurement: c16 read 410-467 KB/s on the decaying corpus and
**1,189 KB/s** on healthy content.

**Tell:** the run fetched references from a broadcast more than about a day old, and had no control
made of somebody else's content.

### B. The publish path, affects anything quoting the 1080p profile as a 6 Mbps stream

The publisher has no rate limit of its own, so it runs at whatever drains its socket, and its
wallclock timestamps record that pace as the stream's frame rate. Across the internet to the
deployment host that is **2.7-3.3 Mbps**, not 6.

⛔⛔ **This one has been attributed three times and the first two were wrong**: first to
`HLS_FRAGMENT`, then to the deployment host, now to the path. `segment-stretch-2026-08-12.md` carries
the reproduction. **The measurement was right every time.**

**Tell:** the document says "1080p / 6000k" and then divides by a duration, or quotes a headroom
figure without saying which publisher it assumes.

### C. Instruments that could not fail, affects soundness claims rather than numbers

A guard whose sensor cannot report a failure is not evidence. Known instances: the e2e browser
harness's visibility and timer checks, which Playwright forces to pass, and `--cache-capacity=0`,
which disabled no cache at all.

**Tell:** a run reports "sound" or "control passed" without anywhere showing that arm failing.

## The register

| document | flag | what survives | what does not |
| --- | --- | --- | --- |
| `srs-fragment-bracket-2026-08-11.md` | B | the six-arm bracket, min = max on every arm | "our deployment doubles", withdrawn in place |
| `shipping-profile-sustains-2026-08-11.md` | B | 0.9996 ratio, zero stalls, 90.8s lead, the fill-phase capability | the cause given for 3.21 Mbps |
| `concurrency-on-healthy-content-2026-08-11.md` | B | c4 1,134 and c16 1,189 KB/s, and the design conclusion | one headroom number stated without its publisher |
| `fresh-vs-decayed-2026-08-11.md` | - | all of it. This is the document that **found** flag A | - |
| `size-on-healthy-content-2026-08-11.md` | - | all of it, 40/40 delivered at every size | - |
| the pre-2026-08-11 in-browser series | A | every figure, **as a floor** | every figure as a ceiling |
| `swarm-hls-operating-profiles` and the pre-freeze-fix latency work | - | method only | every number, retired earlier |

## ⭐ What the audit changed about how to read the rest

**A claim's number and a claim's cause fail independently, and the cause fails more often.** Of the
three contaminations here, exactly one (A) invalidated numbers. B and C left every measurement intact
and broke only the sentence explaining it. That is the opposite of what "contaminated data" suggests,
and it is why voiding whole files would have destroyed more than it cleaned.

⚠️ **This register is not a proof of coverage.** It was built by grepping for the figures already
known to be wrong, which cannot find a wrong claim nobody has questioned yet. What it is good for is
stopping a corrected result from being quoted in its uncorrected form, which has now happened twice.

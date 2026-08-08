# A twenty-fold better median that fixes nothing

**2026-08-08, 17:34 to 17:44 UTC.** Ten arms at 128 concurrent paced viewers on an unfunded gateway,
re-running the jitter comparison to settle a disagreement the published report left open. **Cost:
nothing.** The chequebook was byte-identical before and after.

[The jitter report](jitter-is-not-what-breaks-a-herd-2026-08-08.md) measured a jitter of one whole
segment duration twice and got **6774ms of ending lag in one round and 9ms in the other**, called the
result ambiguous, and said explicitly that a third round would be free and had not been run. This runs
three more.

## ⭐ Two method changes, both from lessons paid for the same day

⭐ **A throwaway arm at the head of every round.** The
[cold gateway finding](a-cold-gateway-needs-a-minute-2026-08-08.md) showed that the first arm after a
container recreate costs two to three times what settled arms cost. Here it worked exactly as intended:
the throwaway absorbed **16321ms of ending lag and 44.5% of segments over budget** in round 1, and came
back at **0ms and 0.8%** in round 2 and **0ms and 0.0%** in round 3. **Every measured arm ran on a warm
node.**

⚠️ **The sitting stopped after ten of sixteen arms**, on the host-load guard, at a mean of 49 runnable
tasks against a ceiling of 48. That is the guard working. It also means round 3 is incomplete and round
4 never ran.

## ⭐⭐ The result, pooling every reading ever taken of these arms

| | ending lag, every reading | median | range |
| --- | --- | ---: | ---: |
| **J0**, the herd | 9437, 9711, 8915, 13191, 10555 | 9711ms | 8915-13191 |
| **J267**, a whole segment of jitter | 9, 1138, 6774, 7209, 8721 | 6774ms | **9-8721** |
| **S16**, positional spread | 0, 0, 0, 0 | **0ms** | **0** |

⭐⭐ **The herd is consistently bad. Jitter is inconsistently bad.** J0 lands inside a 1.5x band across
five readings. J267 spans three orders of magnitude across five, and the 9ms round that made the
original result look promising is **one reading in five**.

✅ **Positional spread is zero, every round, every sitting, without exception.**

⛔ **So the published caveat stands and is now properly supported.** A whole segment duration of jitter
must not be quoted as working. It is not that it fails, it is that **you cannot tell in advance which
kind of round you are going to get.**

## ⭐⭐ The part worth reading twice: what jitter actually does

Jitter is not doing nothing. It is doing something large, to the wrong quantity.

| | J0, the herd | J267 |
| --- | ---: | ---: |
| **median segment transfer** | 252 / 243ms | **11 / 14ms** |
| share over the 267ms budget | 43.2 / 40.1% | **19.9 / 13.6%** |
| **ended behind** | **13191 / 10555ms** | **7209 / 1138ms** |

⭐⭐ **The median transfer improves by a factor of twenty, from about 250ms to about 12ms, and viewers
still end seconds behind.** The late share halves. The thing that decides whether a viewer stalls does
not reliably move at all.

⭐ **This is the cleanest example this project has produced of its own most expensive lesson.** A median
is the average experience, and a buffer does not drain on average experiences. It drains on runs of
consecutive late segments, and a distribution can improve enormously at the middle while leaving the
tail that empties a buffer intact.

⚠️ **Anyone shipping on the median here would have shipped jitter as a twenty-fold win.** The ending lag
is what says otherwise, and it is the only statistic in the table that does.

## ⚠️ One arm is excluded and it is worth saying why

Round 3's J0 came back at **194ms of ending lag and 11.9% over budget**, against 13191 and 10555 for the
same arm in rounds 1 and 2. It is also the arm that tripped the load guard, at a mean of 49 runnable
tasks where the other arms sat at 21 to 36.

⚠️ **The guard measures the whole box, not this probe's share of it**, so a burst of work from one of the
forty unrelated bee nodes on this host would produce exactly that signature. Something about that arm
was different and the instrument says so, which is the entire reason the load column exists.

⛔ **It is left out of the J0 figures above and it is not evidence for anything.** Excluding an
inconvenient outlier on a hunch would be indefensible. Excluding one that carries an independent
instrument reading, flagged automatically and quoted here, is a different act.

## ⚠️ What this does not show

⚠️ **Why the J267 rounds differ so much from each other** is still unexplained. The mechanism proposed
in the earlier report, that a segment of jitter sits exactly where temporal jitter starts turning into
positional spread, predicts a boundary and therefore predicts instability. That is consistent with five
scattered readings and is not confirmed by them.

⚠️ **A jitter of one segment duration is a direct latency cost at the live edge** even in the rounds
where it helps, so it was never a free option.

⚠️ **One concurrency, 128, one gateway, one bitrate**, and the herd being modelled is every viewer at an
identical playback position, which is the shape after a common shock rather than the steady state.

⚠️ Unfunded gateway, 100 references, one host, three rounds of which the third is partial.

## Artifacts

`/home/solarpunk/retrieval-probe/JIT4/`, with earlier readings from `jitter1` and `JIT3`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`, jitter is the 8th arm field and spread the 7th. The shipped
client default remains `GATEWAY_REQUEST_JITTER_MS = 0`, unchanged by this sitting, and nothing here
argues for turning it on. Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and
confirmed on the node.

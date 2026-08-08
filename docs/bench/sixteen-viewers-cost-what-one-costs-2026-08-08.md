# Sixteen viewers cost the network what one viewer costs

**2026-08-08, 10:44 to 10:48 UTC.** Eight arms on `latbench`, an unfunded gateway, concurrency
alternated **1, 2, 1, 4, 1, 8, 1, 16** so every loaded arm is paired against a reference arm beside it.
Same 100 references, same order, every viewer walking the same list at the same time, because that is
the topology a live event has.

**Cost: nothing.** A node with no chequebook cannot spend.

This was meant to find the concurrent-viewer knee. It found something better, and it corrects two
figures this project published earlier today.

## ⭐⭐ The headline: the network cost of a viewer is zero when viewers share a gateway and a stream

| arm | viewers | retrieval operations | **network peer contacts** | accounting skips | bee CPU-cores |
| --- | ---: | ---: | ---: | ---: | ---: |
| U1a | 1 | 2,638 | **3,260** | 74,112 | 2.21 |
| U2 | 2 | 5,028 | **3,167** | 67,067 | 1.48 |
| U1b | 1 | 2,638 | **3,218** | 70,722 | 1.37 |
| U4 | 4 | 10,028 | **3,287** | 77,744 | 1.58 |
| U1c | 1 | 2,638 | **3,189** | 72,906 | 1.49 |
| U8 | 8 | 20,078 | **3,227** | 82,116 | 1.90 |
| U1d | 1 | 2,638 | **3,213** | 75,892 | 1.44 |
| U16 | 16 | 38,968 | **3,250** | 89,408 | 2.17 |

⭐ **Peer contacts range 3,167 to 3,287, a 3.7% spread, while retrieval operations move 15x.** That
number is one viewer's worth of distinct chunks, and it does not move when fifteen more viewers ask
for the same thing at the same moment. **bee fetches each distinct chunk from the network once and
serves every concurrent viewer from that one fetch.**

✅ **Throughput scaled 16.7x**: 9 MB in 15s at one viewer, **150 MB in 15s at sixteen**.

✅ **The median did not degrade**: reference arms ran 88, 82, 75 and 72ms, loaded arms 66, 72, 70 and
80ms. There is no ordering.

⚠️ **The late share roughly doubles**, from a 4.0% mean across the four reference arms to **8.9%** at
sixteen viewers. That is the real cost and it is modest.

⚠️ **bee's CPU is roughly flat at 1.4 to 2.2 cores** across the whole range, so **CPU per viewer falls
16x when viewers are pooled.**

## ⛔ Two corrections to figures published earlier today

### "37 accounting skips per chunk" is not a property of a chunk

Skips came out at **74,112 / 67,067 / 70,722 / 77,744 / 72,906 / 82,116 / 75,892 / 89,408** across
arms whose workload varied 15x. That is **4,715 to 6,317 skips per second**, a 34% spread against a 15x
change in work.

⛔ **It is a rate, not a per-chunk cost.** Dividing it by the throughput a particular arm happened to
run at gives 28.1 skips per chunk at one viewer and **2.29 at sixteen**. Both are the same node doing
the same thing.

### "1.28 network contacts per chunk" has the same defect

At one viewer, contacts divided by retrievals is 1.24, and against a funded node's 1.14 that was
published as an unfunded node adding ~13% network load. **At sixteen viewers the same arithmetic gives
0.083 contacts per chunk**, which is physically impossible as a per-chunk quantity.

✅ **The single-viewer comparison stands**, because there each retrieval is a distinct chunk and the
arithmetic means what it says. ⛔ **It does not generalise to concurrency**, and the earlier
CPU-per-viewer figure derived from single-viewer arms is wrong for any pooled topology.

⚠️ **And one assumption underneath it is unverified.** `bee_accounting_accounting_blocks_count` lives
in the accounting package, which serves pushsync and pullsync as well as retrieval, so it may count
more than the retrieval loop's skips. The rate-like behaviour above is consistent with that. Nobody
has read that part of the source, and **no figure that subtracts skips from attempts should be quoted
until somebody has.**

## What this means for a high-scale event

⭐ **Pool viewers behind gateways. Do not run one bee node per viewer.**

| topology | network contacts | bee CPU | viewers per 48-core host |
| --- | --- | --- | ---: |
| one node per viewer | ~1 viewer's worth **each** | ~1.5-2 cores **each** | **~25 to 30** |
| 16 viewers per node | ~1 viewer's worth **total** | ~1.5-2 cores **total** | **~400** |

⚠️ **Derived from a four-minute sweep**, and the caveats are real: arms were 13 to 15 seconds, the 16
concurrent `curl` processes consume host CPU that is not counted here (only bee's PID is), and nothing
was tested above 16. **Confirm the shape before sizing anything on it.**

⭐ **It also amortises the unfunded penalty.** The skip rate is fixed per node, so sixteen viewers
behind one unfunded gateway each carry a sixteenth of it. That does not make an unfunded gateway
correct, since the late share still doubled and the first fetch of any chunk is still slow, but it
changes the arithmetic of a large deployment considerably.

## This is LAT-11's result, at 16x the range

[LAT-11](../reviews/roadmap.md) measured 8 viewers on one gateway against 1 during a live broadcast and
found **1.09x more chunk retrieval** for 8x the viewers, with the cost landing on request handling and
feed freshness rather than on retrieval. This sweep says the same thing with a sharper instrument and
no broadcast at all: **1.00x network contacts for 16x the viewers.**

⚠️ **What this sweep cannot see is what LAT-11 measured.** Feed staleness went 1.30x at eight viewers,
and that is a live-broadcast property this probe has no access to. **Retrieval scales. Whether the feed
does is a separate question and the answer there was no.**

## Artifacts

`/home/solarpunk/retrieval-probe/conc1/`. Probe: `deploy/scripts/retrieval-debt-probe.sh` with viewers
as the fifth arm-plan field. The gateway was restored to `--swap-enable=true` and `--cache-capacity=0`
and confirmed on the node.

# One rung's postage runs dry and the other three carry the broadcast, proven live, 2026-09-05

The second drain sitting, and the first that returned a verdict. Scenario L
(`e2e/suites/scenarios/batch-drain.test.ts`) is green on the live stage: the 1080p rung's batch filled,
bee refused the rung, the other three rungs kept publishing, and the master stopped offering the dead
rung. The first sitting of 2026-09-04 returned two findings instead (the fragment length lived in a shell
export the uploader never saw, and a filling batch degrades rather than dying). Both are fixed and the
fixes are what this sitting exercised.

## The stage

- Trunk `cb333ca`, `pnpm verify` green, the uploader redeployed at it 10:22Z and the browser client
  10:27Z (build stamp naming the trunk's trees). Every other container kept its uptime, gateway peers 134.
- Ten preflight gates green at 10:57Z, the client-shape gate included.
- The drain batch: `e6d8d79f6486060013a8423fa2350403c8a3da5c907006ec9e98d5cf79394f3e`, depth 17,
  immutable, bought by the owner at 10:50Z on the 1080p node for 0.0383 BZZ, read at arm time as
  0 of 2 chunks in the fullest bucket, 48.0 hours left, usable. The batch of the night before could not be
  armed: bee counted two chunks in its fullest bucket from the orphaned broadcast, and the armed-stage
  gate refuses any used batch.
- Fragment length 2.0 s in the engine's own env file, the uploader dating segments at the same value.

## The chain, and its timeline

`drain-sitting-chain.sh e6d8d79f… e2e:batch-drain`, every stage exit 0.

| stage | began | ended | exit |
| --- | --- | --- | --- |
| balances read, all five nodes | 10:58:26Z | | |
| `drain-stage.sh arm --rung=1080p` (rewrite, uploader redeploy) | 10:58:29Z | 10:59:14Z | 0 |
| `bench-on-host.sh --script e2e:batch-drain` (ten gates, then L) | 10:59:14Z | 11:01:09Z | 0 |
| `drain-stage.sh restore` (original back, uploader redeploy, record cleared) | 11:01:09Z | 11:01:49Z | 0 |
| `bench-on-host.sh --script e2e:abr-ladder` (ten gates, then the ladder suite) | 11:01:49Z | 11:02:52Z | 0 |
| balances read again | 11:02:55Z | | |

Scenario L itself ran 74.8 s. The ladder suite after the restore is green, five of five, so the stage is
whole again with the original batch `709b3e21…` publishing 1080p.

## What the suite asserted, and what it only observed

Asserted, and green: the armed rung was refused (bee answered `402 batch is overissued`, the words now
reaching the log), the master came down to 720p, 480p and 360p inside the 240 s of patience the suite
gives the ramp, and no surviving rung lost a segment while the drained one did.

Observations, none of them asserted:

- The batch took 15.7 s of broadcast to fill.
- The master was rewritten 37.3 s after the first refusal.
- 20 segments dropped on 1080p across the broadcast, read as the difference of two scrapes.
- The ramp of `live/stream_1080p` in ten second buckets: 0-10 s 3 landed 3 dropped, 10-20 s 1 landed
  4 dropped, 20-30 s 5 landed 0 dropped, 30-40 s 0 landed 2 dropped, 40-50 s nothing, 50-60 s 1 landed
  10 dropped. Its last segment landed 51.5 s after the first refusal.

The ramp is the point the plan made in advance: an immutable batch refuses a chunk whose bucket is full,
so the rung thins out over about a minute rather than falling silent at once. The 2026-09-04 model
expected about eighteen refusals for a depth 17 batch and the sitting counted twenty drops.

## What it cost

| node | available before | available after | spent |
| --- | --- | --- | --- |
| 360p, the coordinator (:10075) | 5.8408 | 5.8205 | 0.0202 BZZ |
| 480p (:11071) | 2.0581 | 2.0507 | 0.0075 BZZ |
| 720p (:11073) | 5.1065 | 5.0900 | 0.0165 BZZ |
| 1080p, drained (:11075) | 5.5109 | 5.4960 | 0.0149 BZZ |
| gateway (:10077) | 11.0678 | 11.0678 | 0 |
| total | | | 0.0591 BZZ |

Plus the 0.0383 BZZ batch. About four minutes of a four rung broadcast, counted twice for the arm and
the ladder check, on the owner's 5 BZZ authorisation of 2026-09-04. `availableBalance` read, never
`totalBalance`.

## What remains

- V11, the viewer half, on each byte source, each with its own fresh batch, because a small batch is
  drained once. Not run yet.
- Decision 5 of the plan, a master assertion after the restore, is not built. The ladder suite after the
  restore covers the stage being whole, not the specific claim.
- The uploader logs of the sitting are kept on the host at
  `~/drain-latbench-1080p-20260905T105832Z-before-arm.uploader.log` and
  `~/drain-latbench-1080p-20260905T110109Z.uploader.log`.

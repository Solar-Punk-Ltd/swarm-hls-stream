# A viewer watches through one rung losing its postage, both byte sources, proven live, 2026-09-06

The two V11 sittings, one per byte source, and both green. V11
(`e2e/suites/viewer/batch-drain-viewer.test.ts`) is scenario L with a real browser watching: the 1080p
rung's batch fills, bee refuses the rung, and the question is what the viewer who was already watching
sees. The answer on both byte sources is the same. The viewer never decoded the drained rung, kept
advancing at real time, rebuffered zero times, and saw the master rewritten under them without a reload.

## The stage

- Trunk `2935091`, `pnpm verify` green, the uploader and the browser client redeployed at it 00:09Z to
  00:12Z (build stamp naming the trunk's trees, gateway peers 134, every bee node and SRS keeping their
  uptime). Before the deploy `bee-publishers.sh --write` moved the 360p rung to the batch `56c72ae8…`,
  since its previous batch sat at 90.6% of a bucket, over the uploader's 90% gate.
- Two drain batches, depth 17, immutable, bought by the owner on the 1080p node at 00:17Z and 00:21Z for
  0.0384 BZZ each: `893ad6b7…` for the in-tab sitting, read at arm time with 33.5 h left, and
  `dbaf577b…` for the gateway sitting, 33.3 h left. Both unused when armed.
- Fragment length 2.0 s, the in-browser profile for both sittings, and `BROWSER_FETCH_BACKEND=gateway`
  on the second, which is the arm the environment beats the profile file for by design.
- The same day, before these sittings, the full suite had run green on the in-tab byte source at this
  trunk (29 scenarios, 37 cases), so the stage the viewer met was one already read end to end.

## The chains, and their timelines

`drain-sitting-chain-v2.sh <batch> e2e:batch-drain-viewer [BROWSER_FETCH_BACKEND=gateway]`, every
stage exit 0 in both. The v2 chain differs from the 2026-09-05 chain in one place: the closing step is
`e2e:ladder-restored`, the ladder suite and the master suite together, which is decision 5 of
`docs/e2e-batch-drain-plan.md`.

| stage                                                         | in-tab began | in-tab ended | gateway began | gateway ended |
| ------------------------------------------------------------- | ------------ | ------------ | ------------- | ------------- |
| `drain-stage.sh arm --rung=1080p` (rewrite, uploader redeploy) | 14:56:08Z    | 14:57:01Z    | 15:07:32Z     | 15:08:28Z     |
| `bench-on-host.sh --script e2e:batch-drain-viewer` (gates, V11) | 14:57:01Z    | 15:04:06Z    | 15:08:28Z     | 15:15:34Z     |
| `drain-stage.sh restore` (original back, uploader redeploy)    | 15:04:06Z    | 15:05:02Z    | 15:15:34Z     | 15:16:26Z     |
| `bench-on-host.sh --script e2e:ladder-restored`                | 15:05:02Z    | 15:06:24Z    | 15:16:26Z     | 15:18:26Z     |

The viewer watched from 14:57:34Z to 15:03:55Z in the first sitting and from 15:08:57Z to 15:15:16Z in
the second, six minutes and twenty seconds each time. The ladder-restored step was green after both
restores, so the stage was whole again with the original batch `709b3e21…` publishing 1080p.

## What the suite asserted, and what it only observed

Asserted, and green on both byte sources: the ten preflight gates, the armed rung refused, the other three
rungs carrying the broadcast, and a viewer who was already watching keeping a picture through it. The
in-tab arm also carried the byte-source proof, which is the whole-run ceiling of nine gateway reads: the
in-tab viewer made 4 segment requests over six minutes, the gateway viewer 184, so the two arms were
what they were filed as.

Observed, none of it asserted:

- The viewer decoded 1280x720 in both sittings and never the drained rung's 1920x1080. The 1080p rung's
  playlist stopped advancing within the first half minute, and the ABR never had a reason to climb back
  onto it.
- Advance 1.000 of real time on the in-tab byte source and 1.003 on the gateway, zero rebuffers and zero
  stalled samples in both, 6.06 s and 7.03 s behind live.
- The master was rewritten at 14:57:39.026Z and 15:09:00.845Z, five and four seconds after each viewer
  joined, while they were watching. Neither viewer reloaded and neither lost the rungs it had, which is
  the half of decision 5 that only this suite reads.
- The ramp of the drained rung, in ten second buckets: 2 landed and 3 dropped in the first ten seconds
  on the in-tab sitting, then one or none landing and four to six dropping per bucket for the rest of
  the broadcast. The gateway sitting ramped a little slower, 2 landed and 4 dropped, then 3 and 2, then
  none landing from the second minute on. The drained uploader's own log, dumped by the restore, holds
  178 failed segment uploads on the in-tab sitting.
- The master named all four rungs 12.8 s and 12.7 s after the last of them announced on the two
  ladder-restored runs, against 8.5 s on the morning's run after the redeploy.

## Cost

Read as the difference of the available chequebook balance on each node either side of each chain.

| node                 | in-tab sitting | gateway sitting |
| -------------------- | -------------- | --------------- |
| 360p publisher       | 0.0374 BZZ     | 0.0328 BZZ      |
| 480p publisher       | 0.0314 BZZ     | 0.0318 BZZ      |
| 720p publisher       | 0.0868 BZZ     | 0.0863 BZZ      |
| 1080p publisher      | 0.0201 BZZ     | 0.0223 BZZ      |
| gateway              | 0.0031 BZZ     | 0.0615 BZZ      |
| broadcast total      | 0.179 BZZ      | 0.235 BZZ       |

Plus 0.0384 BZZ for each drain batch. The 1080p publisher paid a fifth of what the 720p publisher paid,
because a refused rung uploads nothing, and the gateway's share is twenty times higher on the gateway
sitting, because that is the node that served the viewer's 184 segment reads.

## What this leaves

Nothing of the drain plan. Scenario L on 2026-09-05 and V11 on both byte sources today are the sittings
decision 6 asked for, and decision 5's master suite ran green three times against the redeployed stage.
The V11 assertions are about a viewer with a picture, not about how quickly the drained rung fell out
of the ABR's reach, and the ramp readings above are the shape to look at first if that ever becomes a
question.

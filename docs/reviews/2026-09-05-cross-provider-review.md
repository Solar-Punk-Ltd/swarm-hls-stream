# The cross-provider review of 2026-09-05, verified and answered

An OpenAI-hosted reviewer read the repository at `4e0474b` on 2026-09-05 and reported six actionable
findings, five of them demonstrated with in-memory probes. This page records what the coordinator
verified against the code the same day, what was built in answer, and what the owner still has to
rule on. The reviewer changed no files and ran nothing live.

## The six findings, each checked against the code

| #   | Severity | Claim                                                                                                                                                                                                  | Verified                                                                                                                                                                                                                                                                                                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1       | Recovery rebuilds the duplicate filter from the restored segment indexes, and a re-announce during recovery keeps it, so a restarted engine's new session loses its first segments as "duplicates"     | Yes. `startStream`'s recovery branch cancels the timer and returns with the old filter, while the live re-announce path (CON-16) retires the session and starts fresh. The code's own comments establish that an engine whose session stayed open never calls `startStream`, so a call during recovery is a new session by construction | Landed as `2d86b84`: the recovery branch of `startStream` starts the duplicate filter fresh and forgets the accounting index, since every caller of that method is a fresh publish session. `ManifestManager.placeInBroadcast` already re-anchors a restarted counter forwards. Red first with the reviewer's own probe, and a control that a session resuming by delivery still has its window absorbed. Every `startStream` caller was read (SRS on_publish twice, OME's opening admission, the HTTP start route) and each fires on a new session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | P1       | The retry helper checks its deadline only after a rejection, and every Bee client is built with bee-js's default request timeout of zero, so a hung connection holds a queue for ever                  | Yes. `new Bee(url)` with no options, bee-js 9.8.1 hands axios `timeout: 0`, and `StreamUploader.ts` says in its own comment that the helper bounds retries and not one slow call                                                                                                                                                        | Landed as `f920f78`, `3e90aae`, `39c697e` and `e96ef7e`: every pooled Bee client carries a request deadline from a new `BEE_REQUEST_TIMEOUT_MS` knob (default 4 s, derived so two attempts fit the shortest 10 s retry window, re-derived by a config test that reads the windows out of the source), and `retryUntilDeadlineAsync` races each attempt against what is left of its deadline, rejects with a named `RetryDeadlineError`, and ends the retry when a backoff would reach the deadline rather than firing an attempt with no time left. Proven red against a real local server that accepts and never answers, with a zero-timeout control that hung as before. ⚠️ Nothing on the stage measures upload durations, bee exposes no per-request API histogram and the uploader logs no duration, so the 4 s default rests on the retry arithmetic and on the queue keeping up with 2 s segments, not on a measured distribution. The first live run after deploy must read the uploader log for `timeout of` lines. Three startup reads (chequebook, postage, connectivity) had no retry wrapper and now get one bounded attempt, which turns a silent boot hang into a named refusal |
| 3   | P1       | The uploader image installs from the package manifest alone with `npm install --omit=dev`, without the lockfile or the root overrides, so production resolves versions nobody reviewed                 | Yes. `deploy/test/uploaderImage.test.js` even documents the re-resolution. The client image already installs from the frozen lockfile, the uploader image did not                                                                                                                                                                       | Landed as `5947fad`: the image now installs from the workspace lockfile and the root manifest with `pnpm install --frozen-lockfile --prod`, then `pnpm deploy` writes the flat runtime tree a single COPY carries, and the deploy script ships the lockfile, the root manifest, the workspace file and the shared manifest to the host. Measured on the real image before the change: the override pinned axios at ^0.33.0, the workspace resolved 0.33.0, the image ran 0.30.3. After: the image's axios, qs, ws, form-data and follow-redirects match the lockfile, the image starts to its config validation rather than to a module error, and it is 248 MB against 276 MB. `pnpm deploy` on 9.12.0 ignores `--frozen-lockfile`, measured, which is why the install pass stays as the gate. Tests read the Dockerfile's COPY list and assert every path is synced                                                                                                                                                                                                                                                                                                                           |
| 4   | P2       | `video/a_b` and `video_a/b` are both valid stream ids and both map to `video_a_b.json` in the recovery store                                                                                           | Yes. `getFilePath` maps `/` to `_` and the id charset allows `_`. Recovery itself uses the `streamId` inside the file, so the damage is one live stream's entry overwriting or deleting another's                                                                                                                                       | Landed as `1a92934`: entries are filed under the percent-escaped id, so only `/` changes and no id can spell another's name. Entries written under the old flattening are still read, quarantined and removed, and the first save after an upgrade retires the old file so one broadcast cannot become two entries. `listActive` hands back ids. The live suites use the listing only as opaque file names, checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | P2       | The internal sequence preserves gaps in the engine's counter while the playlist lists only present segments, so a retained segment's HLS sequence number changes when the window advances across a gap | Yes, for the published rolling playlist. The shipped client is shielded: it accumulates segments by URI and never renumbers, so an attached viewer's numbering stays fixed. A fresh joiner reads one self-consistent window. The cross-rung agreement the numbering was designed for already breaks at a gap in one rung                | DECISION, see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | P2       | The catalog records the new rung set as advertised before the master write, so a failed correction is never retried during a steady broadcast                                                          | Yes. The docstring concedes it and leans on the next transition or announce, which a steady broadcast never produces                                                                                                                                                                                                                    | Landed as `c55f384` and `6aaa584`: `advertised` records only the shape the feed took, in both places that write it, an in-flight mark keeps a burst to one write, and a failed rewrite holds the group off for thirty seconds before the next delivery retries. The cleanup removes only its own mark, so two transitions inside one write window cannot queue a duplicate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The reviewer also noted that the coverage map's drain row said neither drain suite had passed live
while the drain plan recorded scenario L green on 2026-09-05. Correct, and fixed with the rest.

## Found on the way and left as they are

- The whole-stack restart scenario (I) stayed green with finding 1 in the code because its trigger is
  absent: it starts one publisher with no reconnect, so no `on_publish` ever follows the restart, and
  after the restart it asserts a VOD landed, nothing stays active and the recovery directory is empty,
  never that the new session's segments were published. A live proof of finding 1 needs a publisher
  that reconnects after the stack comes back.
- `republishIfLadderShapeChanged` compares the liveness shape, rungs that have delivered, while the
  master is written from the announced renditions minus dead ones. During warmup the two differ and
  converge once every rung has delivered, which is the only regime the rung-death correction runs in.
  Pre-existing, unchanged.
- `e2e/src/harness/uploaderState.ts` documents `recoveryEntryIds` as stream ids when it returns file
  stems. Every caller treats them as opaque names, so behaviour is unchanged, the docstring is loose.
- The 2026-07-29 hardening audit and handoff still describe the npm install in rows ARCH-1, OPS-16,
  OPS-17 and SEC-11. They are dated records and stay as written. OPS-17 is a live question again: CI
  builds no image, and the install is more machinery than before.
- `pnpm deploy` prints a harmless `WARN Failed to create bin` for acorn on every build. The tree is
  right and acorn is not in the image.
- A cold image build took 527 s on this connection, dominated by registry resets. Cached-base builds
  ran 21 to 42 s. The first deploy after this lands is slower than the npm install was.
- The client's `test/` folder is not typechecked, and the recording driver still matches the VOD line
  by a literal rather than the shared log contract, and `UPLOAD_RETRY_WINDOW_MS` still lives in the
  crash-arm module. Each is a small follow-up.

## Finding 5 is a design choice and waits for the owner

**What happens.** `ManifestManager.placeInBroadcast` gives every segment a sequence of
`anchor.sequence + (index - anchor.index)`, so a segment the engine closed while nothing took it
leaves a hole in the numbering. The live playlist then writes `#EXT-X-MEDIA-SEQUENCE` as the first
listed segment's sequence and lists only the segments it holds. HLS numbers listed segments
consecutively from that header, so while the window's head sits before the hole a segment behind it
carries a number one lower than its own, and the moment the head crosses the hole the same segment
gains one. The published rolling playlist therefore renumbers retained media once per gap.

**Who it reaches.** Not the shipped client: `ManifestManagement` keeps every segment it has seen,
keyed by URI, keeps the first header it captured and appends, so an attached viewer's numbering never
moves. A viewer joining fresh reads one window and it is consistent with itself. What it does break
is the promise the numbering was built for, that segment N of 360p and segment N of 1080p cover the
same instant across a ladder: a hole in one rung shifts that rung by one against its siblings for a
fresh joiner. Any player reading the published playlist directly, and the harness's own manifest
contract check, see the unstable numbering.

**Option A, say the gap.** Emit the missing indexes as `#EXT-X-GAP` entries with the rung's fragment
duration, so numbering stays index-derived and the ladder stays aligned by construction. This is what
the HLS specification has for a segment that is not there, and the pinned hls.js 1.6.15 parses the
tag and skips such segments. It also questions today's discontinuity at an inferred loss, since a lost
segment does not reset the encoder's clock, the timeline has a hole in it. The risk is player behaviour
at the live edge with a gap entry, which only a live sitting can answer.

**Option B, count what is published.** Number segments consecutively per rung and keep the dating,
`#EXT-X-PROGRAM-DATE-TIME`, index-derived from the shared anchor. hls.js aligns a level switch by the
date-time tags when both rungs carry them, so the cross-rung sequence agreement stops being needed.
It reverses a deliberate design decision recorded in the code, the argument that a count drifts across
rungs the moment one starts a fragment late, and it touches the live manifest contract check and the
client's ladder tests.

**Recommendation: A**, because the whole ladder design rests on index-derived numbering and the
specification has the exact tool for a missing segment. Either way the change is proven in a sitting
before it ships, on both byte sources, with a deliberately dropped segment.

**Ruled 2026-09-06: Option A, say the gap.** Built on `wt/gap-entries`. `ManifestManager` in
`packages/stream-uploader/src/libs/ManifestManager.ts` lists every missing sequence between two held
segments as an `#EXT-X-GAP` entry with the derived date-time, the declared fragment length and a URI
of `gap-<sequence>`, in the live window and in the recording alike, and budgets those lines against
`LIVE_WINDOW_MAX_BYTES`. The three loss paths in
`packages/stream-uploader/src/libs/StreamUploader.ts` no longer arm a discontinuity, which answers the
question the option raised, and they keep their log lines unchanged. `#EXT-X-GAP` was added to
`packages/shared/src/hlsTags.ts` and read into `Segment.gap` by `packages/shared/src/manifest.ts`, and
the viewer writes the tag back in
`packages/client/src/components/SwarmHlsPlayer/ManifestManagement.ts`. On the harness side
`e2e/src/harness/manifestContract.ts` now names gap entries in the failure a silent hole produces, and
`e2e/src/harness/manifestContractLive.ts` counts them per rung beside the discontinuities. RFC 8216bis
§8 asks for no minimum protocol version for the tag, so the playlists stay at `#EXT-X-VERSION:3`.

**Proven live 2026-09-06 at `2935091`, on both byte sources.** After the uploader hard crash of scenario
F every rung said its hole with gap entries and declared no break: 2, 3, 3 and 2 gap entries across the
four rungs on the in-tab sitting, 3, 4, 3 and 3 on the gateway sitting and 2, 2, 1 and 2 on its rerun, 0
discontinuities every time, `#EXT-X-MEDIA-SEQUENCE:0` held. V7, a viewer watching when the uploader is
killed, and V9, a viewer playing through the hole a writer outage tears, were green in a real browser on
both byte sources, so hls.js 1.6.15 skips the entries at the live edge as the specification says it
should. The full suite was green on both byte sources the same day, 29 scenarios and 37 cases each.

## Four older suggestions, still relevant, folded in

Four suggestion chips from earlier sessions were re-checked against `4e0474b` on the same day. All
four still applied.

**A. Typecheck sees weeb-3 API drift.** `Weeb3FetchBackend.ts` loaded the package through
`as unknown as Promise<Weeb3Module>`, which switched structural checking off, and on 2026-09-02 a
made-up method on `Weeb3Node` passed `pnpm typecheck` with no output. Landed as `f2993fe` (the loader
is uncast and `Weeb3Node` extends a pick of the package's own class), `cce441d` (function-typed
properties so a release that narrows a parameter fails too), `893ef72` and `de20582` (the wasm size
is stated once, dated to the pinned release, everywhere else says megabytes). Proven red on three
drift shapes, each quoted in the commit bodies. The emitted bundle is byte-identical before and
after, so the lazy chunk split is untouched. Two things found and left: the client's `test/` folder is
not typechecked at all (`tsconfig.json` includes `src` only and vitest strips types without checking
them), and a release that adds an optional parameter to a member we call still passes, which is
benign.

**B. The recording driver's rung-summed count and its finalize wait.** Landed as `3e4a3ad`, `592514d`
and `3038939`. The driver counted uploads across every rung, so a target of 60 gave 15 per rung on a
four rung ladder. It now counts the minimum across the rungs the broadcast announced and prints the
per-rung media seconds from the segment length it reads off the running engine. Its finalize wait was
a flat 180 s and timed out live four seconds before the uploader finished. It is now derived from the
uploader's own mechanism, one segment plus the 15 s upload window, the 60 s orphan reaper and the 5
minute drain deadline, about 380 s, and the recording's address is printed even when the wait fails.
The outage the driver arms takes away the lowest rung's node only, so on a ladder the discontinuity
lands on that rung alone, which the run now says. Arming every rung would mean stopping four nodes at
once and is left as a question.

**C. One copy of the byte-source proof rule.** Landed as `faa9e19` and `ba5ebb5`, behaviour
preserving. A structural test now fails if an arm module restates the three branches, and the in-tab
gateway-read ceiling of nine lives beside the rule that applies it.

**D. The publish-key test and a subdirectory under the scripts.** Landed as `a96f693`. The test copied
`deploy/scripts` one entry at a time and died with an errno naming a socket whenever python had left a
`__pycache__` there. It copies recursively now, the way the shared sandbox helper does, and a regression
test proves it against a copy of the directory with a `__pycache__` in it. The copy matters: the first
version created the directory in place and aborted a neighbouring test file mid-walk, since the deploy
tests run concurrently and every sandbox walks the real directory. `__pycache__/` is not in
`.gitignore`, which is the owner's call.

The wording sweep on the deploy side landed as `e279694`, and `vendor-shared.mjs` stopped describing
the npm install that no longer exists in `e2f1309`.

## Decision 5 of the drain plan, built

`0419734`, `c943e02`, `9ea0612` and `18b9aa5`. The master-rung poll is one function, a new service
suite reads the ladder's own master off the gateway and asserts it offers exactly the rungs the
broadcast announced, it skips on a stage that is still armed, and `pnpm e2e:ladder-restored` is the
whole post-restore step in one command. It has not run against a deployment yet, the plan says so.

## What the merge itself found

Five builders worked in parallel worktrees off `4e0474b`, each green on its own base. Meeting on one
branch turned two deploy tests red that no worktree could see: the passthrough gate read the note beside
the new master-rungs script as a script that arms, fixed in `2db8c56`, and the unused-export gate
counted five shapes the new e2e helpers exported without anyone importing them, fixed in `2942a86`. The
uploader's request timeout, the recovery fixes and the deploy image met cleanly.

## What the owner decides

1. **Finding 5. Ruled on 2026-09-06: option A**, say the gap with `#EXT-X-GAP` entries. Built on
   `wt/gap-entries`, merged as `2935091`, proven live the same day on both byte sources, see the end of
   the finding 5 section above.
2. **`__pycache__/` in `.gitignore`.** One line. Recommendation: add it, since importing any of the
   six python scripts from the repository root creates the directory and it showed as untracked on
   2026-09-05.
3. **The recording driver's outage.** It takes away the lowest rung's node only, so on a ladder the
   discontinuity lands on that rung alone. Arming every rung means stopping all four publisher nodes
   at once, four crash domains and four chequebooks. Recommendation: leave it, the run now says which
   rung it armed, and a playback run that must cross a discontinuity rides that rung.
4. **The request timeout's default.** 4 s rests on the retry arithmetic, not on a measured upload
   distribution, because nothing on the stage records one. Recommendation: deploy it as is, and have
   the first sitting after the deploy read the uploader log for `timeout of` lines before trusting it.
   **Read 2026-09-06.** The uploader log of the two morning suites, preserved by the drain arm's
   before-arm dump, holds 37 `timeout of 4000ms exceeded` retry lines and 10 dropped uploads, and the
   log of the evening rerun holds 17 and 6. Every one of them sits inside a bee fault window: scenario
   B stopping every publisher node, V8 pausing the writer, V9 stopping it. No timeout and no dropped
   upload on any clean broadcast, in three full sittings. The default stands.

## What ran on 2026-09-06, and what it cost

The stage was redeployed from `2935091` at 00:09Z to 00:12Z (uploader and client, every bee node and SRS
keeping their uptime, gateway peers 134, the 360p rung moved to a batch at 15.6% by
`bee-publishers.sh --write` first). Then, against the 10 BZZ ledger the owner authorised at 00:15Z:

| sitting                                                       | when             | verdict                                                  | broadcast cost |
| ------------------------------------------------------------- | ---------------- | -------------------------------------------------------- | -------------- |
| `pnpm e2e:ladder-restored`, the gates, the ladder, the master | 00:12Z to 00:14Z | green, master named 4 rungs after 8.5 s                  | in the total   |
| full suite, in-tab byte source                                | 00:14Z to 01:15Z | green, 29 scenarios, 37 cases                            | 1.91 BZZ       |
| full suite, gateway byte source                               | 01:45Z to 02:45Z | 19 of 29 read green, the rest lost when the laptop slept | in the total   |
| V11, in-tab byte source, arm, suite, restore, ladder-restored | 14:56Z to 15:06Z | green, all four stages                                   | 0.18 BZZ       |
| V11, gateway byte source, the same four stages                | 15:07Z to 15:18Z | green, all four stages                                   | 0.24 BZZ       |
| full suite, gateway byte source, rerun                        | 15:19Z to 16:19Z | green, 29 scenarios, 37 cases                            | 2.43 BZZ       |

7.25 BZZ of the 10 BZZ left the five chequebooks over the day, plus two depth 17 drain batches at
0.0384 BZZ each. The V11 record is `docs/bench/viewer-through-a-drained-rung-2026-09-06.md`.

The plan the day followed, as written the evening before:

1. `pnpm e2e:ladder-restored` once on the redeployed stage, which is decision 5's suite meeting a
   deployment for the first time. One ordinary broadcast, no arming.
2. V11 on the in-browser byte source, then on the gateway byte source. Each needs its own depth 17
   batch, 0.0383 BZZ at the price read off the chain on 2026-09-05, plus about 0.06 BZZ of broadcast
   across the four publishing nodes. The owner buys each batch from their own shell:

   ```bash
   ssh manager-host "curl -s -XPOST -H 'Immutable: true' 'http://127.0.0.1:11075/stamps/2924605440/17?label=drain-1080p'"
   ```

   then `deploy/scripts/drain-stage.sh --profile=latbench --portSlot=7 --rung=1080p arm --batch=<that id>`,
   the sitting through `bench-on-host.sh --script e2e:batch-drain-viewer` with the byte source's
   profile, `drain-stage.sh ... restore`, and `pnpm e2e:ladder-restored` to close it.

3. A live proof of finding 1 needs a publisher that reconnects after a whole-stack restart, which no
   scenario has today. Filed here, not built. Still the one open item of this review.

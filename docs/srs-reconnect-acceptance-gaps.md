# What the SRS reconnect acceptance does not prove, and what closing it would take

**As of 2026-09-21.** The reconnect and continuation feature is built and its suites are green. What
is **not** established is the end-to-end acceptance with real video on a real server. This page says
exactly which parts of that are missing, what evidence says so, and what each one would cost, so the
gap is a written gap rather than something a later session infers from a fixture nobody could run.

Ruled by the owner on 2026-09-21: **none of the three below is being built now.** The pull requests
were closed and the branches kept on the remote. This page is the record of why.

## Where the feature actually stands

The code is finished and tested. A full-depth run on the verification box passed on the branch head
`248b51c4` (run 35575814424, requested and tested commits matching), covering gate-facts, shared,
cli, audit-gate, deploy, e2e and the stream-uploader floor. An earlier deep run on `9bbd9e58` passed
too, and its `e2e/test:browser:continuation` cases ran in a real Chromium for the first time.

So this is not a page about shaky code. It is a page about one specific thing nobody has watched
happen: a real broadcaster dropping mid-stream, coming back, and a viewer getting one continuous
watchable recording out of it, with a stranger unable to take the stream over while it is down.

## The three gaps, and they are independent of each other

**The one everybody talks about is the first, and closing it alone buys nothing.** A fixture that
starts and reports `completed` while proving neither of the other two is a green that was never
earned, which is the failure mode this repository has been bitten by before.

### 1. The fixture cannot start at all

`e2e/src/continuation` provisions everything through a release guard that no longer exists in any of
the three repositories. `GuardedApplicationProvisioner` installs `deploy/install-release-guard.sh`,
and that file is **not in the tree**. The admin endpoint it submitted receipts to and the
`release_guard_receipts` table it read are both gone as well, the migration having been dropped with
later migration numbers kept.

Guard wiring by file, all under `e2e/src/continuation/`: `provisioner.ts`, `topology.ts`
(the `activate-guarded-release` steps and `submit-release-guard-receipts`), `readinessSource.ts`
(`inspectGuard` reads the dropped table), `readinessTransport.ts` (every probe cross-checks a running
image against a guard artifact), plus `guardedResources.ts`, `runtimeExecutor.ts`,
`runtimeBindings.ts` and `managerProfile.ts`. Roughly 4,400 lines across ten files, with nineteen
`continuation*` suites over them, one of which is named for the thing being removed.

**What replaced the guard**, and what the fixture should drive instead: enrollment now needs only a
fresh uploader capability record, under 30 seconds old and covering the media type, refusing with
`uploader_capability_not_fresh` or `uploader_profile_changed`. The manager deploys managed SRS
profiles through this repository's own `deploy/scripts/deploy.sh`, and `deploy/deploy.sh` is byte
identical to main's again. `ADMIN_API_URL` and `ADMIN_API_TOKEN` are ordinary environment settings.
`deploy/capabilities.json` is the whole of what used to be the guard's compatibility check, read by
the manager at `manager/src/domain/stackContract.ts`. So the four guarded activations become plain
component starts, and the readiness checks lose their artifact comparison and keep the container,
HTTP and capability parts.

**Cost to close:** several days of mechanical rework. **What it buys on its own: a fixture that
runs.** Not either gate below.

### 2. The policy refusal has never been proven, and the code says so in its own type

A stranger publishing to a stream whose broadcaster has dropped must be refused. Nothing has ever
tested that. This is not an oversight that a run would catch, because the fixture **cannot report it
even in principle**: in `e2e/src/continuation/mediaScenario.ts` the evidence interface declares

```ts
closedAttempt: {
  authoritativeRunUnchanged: true;
  policyRefusalProven: false; // a literal type, not a value
  requiredRuntimeWitness: 'srs_on_publish_response_code_1';
}
```

`policyRefusalProven` is typed as the literal `false`, so no code path can set it true, and the
surrounding evidence declares itself `evidenceKind: 'controller-observation'`. The type is honest
about being an observation of the controller rather than a proof of the runtime, and it names the
witness that is missing.

**Cost to close:** capture a real, sanitized SRS `on_publish` callback returning response code 1.
The target is named precisely by `requiredRuntimeWitness`, so there is no ambiguity about what
counts. **Nothing about the guard removal touches this.**

### 3. The media check looks at one pixel per second

The recorded video is sampled in `e2e/src/continuation/mediaScenario.ts` with one ffmpeg filter:

```
fps=1,scale=1:1:flags=area,format=rgb24,showinfo
```

One frame per second, each scaled to **a single pixel**. That can establish that a decodable frame
existed each second. It cannot establish full frame retention, any quality at all, or that seeking
across the seam where the broadcast resumed works. A recording with a visible glitch at the join
would pass this unchanged.

**Cost to close:** a real sampler in place of that line, and a decision about what it must assert.
**Nothing about the guard removal touches this either.**

## What is at risk while these stay open

Two things could be wrong today and nothing would find out until a live broadcast. The recording
could carry a visible fault at the reconnect seam that only a real player shows. And the hijack
protection could be wrong in practice, discovered the day somebody does it.

Neither is a reason to believe the code is wrong. Both are reasons not to describe the feature as
accepted.

## Related, and stale on purpose until this is picked up

`e2e/README.md` still describes the fixture as provisioning "guarded applications" (around line 20)
and refers to "Guarded application resource IDs" in its cleanup note (around line 43). The comment at
`packages/stream-uploader/src/libs/StreamOrchestrator.ts:1303` still names an "authenticated local
release controller". Those are left as they are rather than half corrected, because the wording
should follow whatever actually replaces the fixture.

## One more thing the acceptance run itself needs

It requires the owner's SSH and vault approval and runs on the funded host at 157.90.34.105, where
funded live deployments must not be touched or reused as fixtures. So the run costs BZZ as well as
the days, and that is a separate approval from deciding to build any of the three above.

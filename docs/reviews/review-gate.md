# Review gate

Standing protocol. Every pull request into `feat/ai-hardening` passes this before it merges.

> **FROZEN, owner decision 2026-08-01. Do not edit this document.**
>
> Edit it only when a pull request is actually blocked by something written here. A defect you notice
> in these rules gets one archived row in the register and nothing else, and a protocol finding is
> **capped at MEDIUM** unless it lets a production defect through undetected.
>
> The reason is measured rather than felt. On 2026-08-01 this repository produced 379 lines of process
> documentation against 99 lines of product source, and the round that triggered the freeze was a
> change to these rules, gated by these rules, which found three HIGHs in the new rules and generated
> more rules. **A control that needs continuous maintenance is not controlling anything.**
>
> **Read [the definition of done](./2026-07-29-hardening-audit.md#definition-of-done-and-the-only-queue-that-counts)
> before this file.** It names the only seven findings that are queued, and it outranks everything
> here. A documentation-only pull request gets no lenses at all, not even the claims auditor.

This replaces the Copilot gate described in
[`2026-07-29-hardening-handoff.md`](./2026-07-29-hardening-handoff.md). The Copilot review quota for
the organization is exhausted for the month, so the automated outside reviewer is unavailable. The
gate it occupied is not optional, so it needs a replacement rather than a gap.

**Owner decision, 2026-08-01: do not re-check whether the quota reset.** July ended and a monthly
quota would plausibly be back, which is the cheapest way to restore a genuinely independent reviewer.
The owner has held that check. Do not request a Copilot review on a pull request, and do not treat
its absence as a gap in the gate. Raise it again only if the owner does.

## What the outside reviewer was actually providing

Worth being precise about, because a replacement that misses any of the three is not a replacement.

1. **Independence.** It never saw the author's reasoning. It read the diff and nothing else.
2. **Auditability.** Findings landed in the PR timeline, so "left unaddressed" was a state anyone
   could detect afterwards.
3. **A blocking ritual.** The PR could not be called done until every finding was answered.

The naive substitute, the author re-reading their own diff, loses all three at once. It is not a
weaker version of a review, it is a different activity. Everything below exists to engineer the three
properties back.

## The gate

Five requirements. All five, or the gate is not satisfied.

### R1. Independent lenses, starved of the author's reasoning

Every pull request gets the claims auditor from R3, plus the code lenses the diff in front of you
actually needs. There is no minimum count. [Selecting lenses](#selecting-lenses) is the procedure and it
binds, because a gate that ran the wrong lenses is not rescued by having run several. Each lens is a
separate agent with a single assigned question, spawned fresh.

Each reviewer receives the diff and read access to the repository. Each reviewer is **not** given:

- the pull request description,
- the reasoning behind the commits,
- the author's own account of what the change does or why it is correct,
- the finding in the register that the change is meant to close, or any statement of the expected
  answer,
- the rejected-findings list, for the reason and with the one exception given in
  [R5](#r5-refutations-go-into-the-register).

Withholding the description is the single most important rule here and the easiest one to break by
accident. A PR body in this project is a persuasive document that argues the change is correct. A
reviewer who reads it reviews the argument instead of the code, agrees with it, and reports nothing.
The claims auditor is the sole exception, because for that lens the description is the artifact under
test.

Lens prompts state the failure classes to hunt and require a concrete failure scenario. They must
also say, in as many words, that reporting few or no findings is a good result. Without that, a
reviewer with nothing to report invents something.

### R2. Verification defaults to refuted

No finding is actionable on sight. Every one is checked against the code before anything is fixed,
and the burden of proof sits on the finding.

A finding is CONFIRMED only if it reduces to a specific state or input, then a specific wrong
outcome. If it cannot be reduced to that shape, it is REFUTED. "Fragile", "could be a problem",
"consider adding" and "not best practice" are all REFUTED by definition, whatever their stated
severity.

Verify the stated severity separately from the stated defect. The two fail independently, and in
practice severity fails more often. A real MEDIUM reported as CRITICAL is still a bad finding,
because it reorders the work. Downgrade it, keep it, and say so.

Verify the proposed fix too. A fix can be wrong even when the defect is real, and a plausible wrong
fix is the most expensive thing a review can produce. One round here proposed restoring a quoted
glob that was the exact break CI had just caught.

This is not caution for its own sake. The ten-agent audit that produced the register generated
roughly 120 raw findings, and nine confident, high-severity ones were fabrications. One asserted that
Bee node passwords had been committed, when `.gitignore` covered the path, `git ls-files` returned
nothing for it, and no such commit existed. Another number, "~40 BZZ per segment", was invented
outright. The failure mode of an agent reviewer is not missing defects, it is inventing them
persuasively, and a fabricated CRITICAL costs more than a missed MEDIUM because it gets acted on.

Verification runs commands. Prefer measuring to reasoning. Where a claim concerns past behaviour,
check the base commit with `git show <ref>:<path>` or a throwaway worktree. Where a claim concerns a
tool's default, run the tool.

### R3. Audit the author's claims, not only the diff

A required lens with no equivalent in the tool being replaced, and the reason this gate is better
than that tool in at least one respect.

Every claim in the PR description is extracted and independently verified: exit codes, test counts,
file counts, which scripts exist, what was broken before, tooling version behaviour, and every ticked
box in the test plan. Verdicts are TRUE, FALSE, MISLEADING, STALE or UNVERIFIABLE, each with the
command that was run and its actual output.

The justification is direct evidence from this project. Two real defects in this work were claim
failures rather than code failures. An exit code was reported as zero when it had been read through a
pipe, which reports the last command's status and not the one that mattered. A security pass asserted
"no known vulnerabilities" from reading `package.json`, while sixty dependency advisories were open,
twenty-one of them at runtime scope. A diff reviewer catches neither, because neither is in the diff.
Both are caught by reading the claim and going to check.

Anything FALSE, MISLEADING or STALE gets the description corrected before merge. A PR body is
documentation and it outlives the review.

### R4. The result is posted, not just discussed

The outcome lands on the pull request as a review through `gh`, listing the lenses that ran, the lenses
that were selected against, **the lenses deferred under [what blocks a merge](#what-blocks-a-merge-and-what-only-files-a-row)**,
what was confirmed, what was refuted and why, and what changed as a result. **Deferred is a third
state and it gets its own list.** Folded in with the ones selected against it would be invisible to
[fail closed](#fail-closed), which reads that list as not-selected, so the one rule that could catch a
deferral nobody ever cleared would be structurally incapable of firing on it.

**When the mutation check ran, the result also carries its exact `stryker` invocation, the
`Found N of M file(s) to be mutated` line verbatim, the mutant total, the survivor total, the score,
and the `concurrency` and host core count it ran at.** Five lines, and without them the check has no
artifact at all: the JSON report is gitignored, so scoping the run to one file out of five is
undetectable by the triage lens, which is forbidden from generating its own mutants and is never told
the scope. **The file count is the only one of these that separates a correct scope from a
mis-scoped one**, and it was the only one this rule did not ask for until a lens pointed out that the
hazard was named here and then left undetectable. When the run matched nothing the line does not
exist, and saying so in its place is the required answer rather than an omission. The claim that two
rounds are finally comparable is only true if the numbers are posted somewhere immutable. The
concurrency and core count belong there because a flaky failure scores as a killed mutant, so a run
on a smaller machine reports a better score for a worse suite.
A review that exists only in a session transcript provides no auditability, and once the transcript is
gone nobody can tell whether the gate ran or which lenses it used.

Findings are answered the same way an outside reviewer's would be. Confirmed ones become fixes, one
fix per commit. Refuted ones get a reply carrying the disproof. Neither blanket acceptance nor
blanket dismissal is a valid outcome.

### R5. Refutations go into the register

Every REFUTED finding is appended to the rejected-findings table in
[`2026-07-29-hardening-audit.md`](./2026-07-29-hardening-audit.md) together with its disproof, and
carries a stable `R<n>` id in its first cell. Real findings that fall outside the pull request's
scope become new register rows instead of scope creep.

**Cite the id to shorten the write-up, never to skip the check.** Before verifying a finding, grep the
rejected section for its subject. A hit saves you re-deriving the argument in prose. It does not save
you the verification, and R2 is not amended: the posted result cites R23 **and names the command
re-run to confirm the disproof still holds at this head**. Where the diff touches any file the cited
row's evidence names, the disproof is re-derived in full.

That is not caution for its own sake. Register rows go stale, and this project has the case on record:
CON-20's row predicted a consequence the live measurement then refuted. Several rejected rows are
openly state-dependent, and **R12** even cites a `package.json` line number that this very change
moved. A row saying `retryUntilDeadlineAsync` "throws on exhaustion and never returns null" is a
disproof of one shape of finding against one shape of code, and the day that function learns to return
null the citation closes a real defect while the gate reports pass.

The ids exist for the author's side of the gate. **Do not hand the list to a lens**, because telling a
reviewer what the author considers settled is the anchoring R1 exists to prevent. **One exception, and
it is not optional:** when the diff itself contains register rows, R1's grant of the diff wins and the
lens gets them. That happened on the very pull request that wrote this rule, whose diff rewrote every
rejected row. Accept the anchoring for that round and name it in the posted result rather than
pretending the ban held.

**Ids are permanent and never renumbered.** The next id is one past the highest ever issued, wherever
that row sits in the document, and no id is reused. A row that is later overturned keeps its id and
gains a line naming what superseded it. "Assigned in document order" would have been true only until
the first correction, and the first correction has already happened: the PR #43 table was misfiled
after `## Finding register` and moving it back reordered the section. Under a position-keyed scheme
the next round either issues a duplicate id or renumbers, and renumbering silently repoints every
"refuted before as R23" already published in an immutable pull request comment.

Two things this section has already caught about itself. The PR #43 round appended its table under
the wrong heading, so four refutations sat outside the section that exists to hold them. And the
count in prose has been wrong twice, most recently as "47" against a real 62, which is why nothing
here states a total.

That section holds seven tables now, the original audit's plus one per review-gate round, and it has
already prevented rework. Do not restate its row count here: this sentence claimed nine for several
rounds after the real total passed forty, which is what a hardcoded number next to a growing table does.
It is the only artifact that stops a future round from re-raising a claim that has been investigated and
killed, and it appreciates with every round.

## Selecting lenses

Owner rule, 2026-07-30. Decide per pull request, run what you selected, and name what you dropped.

Lenses fall into two tiers, and the tier decides how the slot is filled.

**Mechanical tier.** The claims auditor and the mutation check. Both mostly run commands and count, so
both run a model tier down. On #29's 13-line config diff, three lenses a tier down cost 49k, 34k and
29k tokens against roughly 50k to 70k each at full tier, and the cheap ones still produced a
byte-level `.gitignore` check and a per-package `outDir` comparison.

**The claims auditor is unconditional. The mutation check runs on every pull request that changes
`src/` or `test/` inside `packages/stream-uploader`.** Only the auditor is unconditional, because only
the auditor has an artifact on every pull request.

Three things about that trigger, each of which took getting it wrong first.

**A test-only diff is not exempt, it is the most informative case.** Mutation testing measures the
tests and merely uses source as the substrate, so changing the tests changes the thing being measured
and unchanged mutants can flip from killed to survived. "Nothing to mutate" confuses the substrate
with the subject. On a test-only diff, scope the run to the source those tests cover.

**The harness covers `packages/stream-uploader`, `packages/shared` and `packages/client`.**
`stryker.config.json` mutates those three `src/` trees and runs all three suites, the first two under
`node:test` and the client under vitest. `audit-gate`, `cli`, `e2e` and `deploy` all have source and
none of them has a runner here, so a change to `packages/cli/src/` gets recorded as **unavailable**,
which is a different word from not applicable and must not read as coverage. Mutating unscoped would
report on a package the diff never touched, and mutating `cli` with the other suites would survive
every mutant and produce pure noise.

⛔ **Widen the `mutate` glob and the command runner together, or not at all.** Widening the glob alone
runs the new files against a suite that never imports them, so every mutant survives and the score
reads as a coverage catastrophe that is really a configuration error. Widening the runner alone adds
runtime and mutates nothing new. TEST-40 in the 2026-07-29 audit is the same defect from the other
direction, where code moved out of the scoped package and the gate kept reporting the same kind of
number over a strictly smaller surface.

⛔ **Two limits on what a score from this harness means.**

`packages/client/test/bundle.test.ts` is excluded from the client run, and it has to be. It builds the
bundle and asserts that the test-only handles are tree-shaken out, which works because vite folds
`import.meta.env.VITE_EXPOSE_PLAYER` to a constant and the guarded branch becomes provably dead.
Stryker's instrumentation wraps that branch in a runtime-mutable switch, so the bundler can no longer
prove it dead and the handle ships. That test measures the emitted bundle, and instrumentation changes
exactly the thing it measures. Left in, it fails under every mutant and scores **every mutant as
killed**, which is a 100% score that means nothing. Stryker's refusal to run against a red baseline is
what catches it, so never force that baseline green.

A mutant in `packages/shared` is invisible to any test that imports it by package name. The sandbox
symlinks `node_modules` back to the real tree, so `@swarm-hls-stream/shared` resolves to the unmutated
original while Stryker mutates a copy nothing imports. Only a test importing by relative path can see
one, which is why shared's own suite scores it and the uploader's and the client's do not.

**Not applicable means genuinely neither**, as on a docs, deploy or CI diff. The selection comment
states which of the three it is, and the claims auditor verifies that statement, because it is a
binary fact one `git diff --name-only` settles and R3 otherwise never looks at the selection comment.

**When it applies, the selection comment also states how many files the scope is expected to match**,
before the run. That is what turns R4's `Found N of M` line into a comparison instead of a glance:
the expectation is timestamped ahead of the number, by the same fail-closed logic that puts lens
selection ahead of the lenses. **The run's scope is a binary fact and the claims auditor verifies it**,
the same carve-out the paragraph above already grants, and it is not covered by the rule that
author-measured mutation figures are UNVERIFIABLE. The score costs an hour to reproduce. Checking one
posted invocation against one `git diff --name-only` costs nothing, and it is the only thing standing
between a mis-scoped run and a gate that records itself as satisfied.

**Reasoning tier, by surface.** Correctness, security, concurrency, behaviour preservation, config
consistency, silent failure, protocol correctness. These genuinely reason, they cost accordingly, and
they are the source of nearly every refuted finding the register holds. Select them from the "Select
when" column and no other way.

1. **The claims auditor runs on every pull request.** It has no substitute and it is never traded away
   for a slot. Two real defects in this work were claim failures rather than code failures, and a diff
   reviewer catches neither, because neither is in the diff.
2. **Pick the reasoning lenses by the surfaces the diff touches.** Read the "Select when" column below
   as binding rather than advisory.
3. **Do not pad to a number.** A one-surface diff takes the auditor plus one or two lenses.
4. **Give each selected lens a genuinely different question.** Three lenses asked the same thing produce
   one finding three times and a false sense of coverage.
5. **Name the lenses you did not run**, in the posted result required by R4. That list is the next
   round's work.

### What blocks a merge, and what only files a row

Owner decision, 2026-08-01, after the PR #46 gate cost roughly 35 minutes of wall clock and 810k
tokens and the owner stopped it twice. **The cut is by what a lens produces, not by how big the pull
request is**, because those are different questions and only the first one predicts whether waiting is
safe.

**Blocking, on every pull request: the claims auditor, the Stryker run, and every reasoning lens the
surface selects except test integrity.** These hunt defects that are live in the code right now, and
PR #46 is the evidence: both HIGHs it found came from reasoning lenses, both were already committed,
and both would have merged.

**Exactly two things defer, and they are named rather than described**, because a rule that describes
its exceptions grows them. **Mutation triage** and **test integrity**. Nothing else, and extending the
list to a third is an owner decision rather than a session's.

**Test integrity has to be named, because the sentence above would otherwise select it.** The
catalogue classifies it as a reasoning lens on "new or changed tests", and rule 2 makes that column
binding. The first version of this section said "the reasoning lenses the surface selects" and left
the catalogue untouched, so it made test integrity blocking and deferred three lines apart. The
**Blocks** column in the catalogue is now the single place that answers this, so the rule and the
table cannot drift.

**The Stryker run does not defer, only the triage of its survivors does.** The run is a background
command: it costs wall clock and no attention, and 188 mutants scoped to a diff is about ten minutes
that overlaps everything else. It is also what emits the `Found N of M file(s) to be mutated` line
that R4 requires and the claims auditor checks against the count committed to in the selection
comment. Deferring the run would delete the only thing standing between a mis-scoped run and a gate
that records itself as satisfied, which is a check this document added one pull request earlier. What
defers is the lens that reads the survivor list and judges equivalence.

### When a deferral expires

**At the next pull request that touches the same surface, not at sprint exit.**

Sprint exit is the wrong deadline for two reasons and both are checkable. The sprint exit gate is
enumerated in [the handoff](./2026-07-29-hardening-handoff.md), not here, and the register is explicit
that the procedure lives in exactly one place, so a deadline asserted from this document binds
nothing. And **no sprint exit has ever been reached in this project**: Sprint 0 is still open with
`S0.3` and `S0.4` unstarted while Sprint 1 and Sprint 2 work has merged. A deadline that has never
once arrived is not a deadline.

Surface recurrence is the right one because the selection comment already computes it. One
`git diff --name-only` answers whether this diff touches a surface with an open deferral, which makes
the expiry mechanical rather than remembered.

**The ledger is a register row, not a pull request comment.** A comment is permanent and checkable by
a reader already looking at that pull request, which is not the reader this needs: a later session has
to find deferrals without knowing which pull requests to open. That is why R5 built a register rather
than trusting the timeline. The row carries the pull request number, the lens, the surface, the head
sha it was deferred on, and the round that cleared it.

**R4 lists deferred lenses as their own third state**, not folded in with the ones selected against.
Those are the two lists R4 had, and [fail closed](#fail-closed) reads "selected against" as
not-selected, so filing a deferral there would have made fail-closed structurally incapable of ever
firing on one.

### Why this is a real weakening, argued against itself

**The safety argument that opened this section was wrong and is withdrawn.** It said every finding
mutation triage and test integrity produced on PR #46 was a coverage gap and never a live bug. That is
an observation about how those lenses phrase findings, not about the state of the code, and the
register contradicts it directly. **TEST-19, HIGH**, from this family: a test that "passed against code
that failed in production on every restart", where one millisecond of latency took it from 4 of 4
delivered to 0 of 4. **TEST-24** took the class to HIGH precisely because contention "silently inflates
the mutation score and hides the coverage gaps the run exists to find". One round is not a sample, and
this document elsewhere refuses exactly this move.

So the justification is not that these lenses are safe to defer. It is that **the deferral is bounded
by an event that recurs on its own**, and that the blocking set holds the lenses the record actually
credits with catching live defects.

**The price, stated plainly.** On the round that motivated this, test integrity found a HIGH: dropping
`live !== undefined` left the whole suite green, and that arm protects crash recovery. Under this rule
that ships and waits for the next pull request touching `tests`. **TEST-25 is the story of an untested
arm turning out to invert the admission decision**, so this is a real cost and not a theoretical one.

**This does not license dropping a reasoning lens for cost.** Selection is still by surface, and
[a lens that gets expensive is a defect in this document](#a-lens-that-gets-expensive-is-a-defect-in-this-document)
still says the response is to fix the process rather than to skip the lens. What changed is which of
two named lenses have to finish before a merge, not which lenses run.

### Keep the diff small, because the diff sets the price

Owner decision, 2026-08-01, and it is the real cost lever rather than the lens count.

The gate is mostly a reviewer of the fix, not of the code the fix touches. On #43, eleven confirmed
findings and almost every one was against the change itself. #29's 13-line config diff drew close to
nothing. A change that opens six new edges earns six lenses, and the six lenses are not the expense,
the six new edges are.

So **a pull request carries one surface**, and grouping several related tasks into it is fine when they
share that surface. That wording is deliberate, because "one task per pull request" would contradict
step 2 of the handoff's working protocol, which says to group related tasks rather than open 48 pull
requests and expects 18 to 22 in total. Roughly 2.5 tasks per pull request and one task per pull
request cannot both be followed, and a later session caught between two standing protocols will follow
neither. Surface is the axis that matters here anyway: lenses are selected by surface, so a second
surface is what actually widens the gate, while a second task on the same surface costs nothing.

**It binds, and it has an artifact.** The selection comment states `git diff --stat` for `src/` and
names the surfaces touched. Exceeding either needs a one-line exception in that same comment saying
why the split was not possible. Without the artifact this is advice, and advice next to a
[fail-closed](#fail-closed) clause is advice that loses.

The line count is the softer half. Roughly 200 lines of `src/` is a prompt to reconsider, not a
refusal. The surface count is the binding half.

#30 is the standing counter-example: four tasks across four surfaces, six lenses all justified, and
the CRITICAL came from the one lens whose question was specifically "what can break while this still
reports healthy". That round paid for itself and is still the shape to avoid. The way to need fewer
lenses is a tighter pull request, not a shorter list on a broad one.

**The pull request that introduced this rule broke it**, and recording that here is cheaper than
letting the precedent stand unremarked. It carried three subjects across at least two surfaces, config
consistency and protocol correctness, with no exception recorded, because the rule did not exist when
its diff was written. The next one does not get that excuse.

**The full catalogue runs as a deep run at the end of each sprint**, paired with the sprint-exit
re-audit in the handoff's working protocol. Sprint exit is when a fix in one domain is most likely to
have quietly broken another, so that is where breadth belongs rather than on every pull request.

The earlier floor of three lenses plus the auditor is **withdrawn**, not merely relaxed. It spent the
same fleet on a 13-line config diff as on a four-task logic change, and a floor invites padding to
reach it, which is the failure rule 4 exists to prevent.

### Lens catalogue

| Lens                   | Tier       | Blocks?        | Select when                                                                     | Hunts                                                                                                                     |
| ---------------------- | ---------- | -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Claims audit           | Mechanical | yes            | **Always**                                                                      | Assertions in the description that were never checked, or are stale                                                       |
| Mutation triage        | Mechanical | no, deferrable | **Any `src/` change.** Stryker generates and runs, the lens only triages        | Survivors that are real coverage gaps rather than equivalent mutants, and the semantic mutations no AST operator produces |
| Correctness            | Reasoning  | yes            | Any logic change                                                                | Wrong output for specific inputs, false green, false red                                                                  |
| Security               | Reasoning  | yes            | Input handling, auth, filesystem paths, CI, dependencies                        | A concrete attack path with a named attacker and what they control                                                        |
| Concurrency            | Reasoning  | yes            | The orchestrator, queues, timers, recovery                                      | Interleavings that corrupt state, lost updates, races between entry points                                                |
| Behaviour preservation | Reasoning  | yes            | Refactors, autofixes, anything claimed to be mechanical                         | Hunks where behaviour actually differs from the version they replaced                                                     |
| Config consistency     | Reasoning  | yes            | Config, scripts, CI, packaging, docs describing commands                        | Two things in the repo that disagree, and what breaks because they do                                                     |
| Silent failure         | Reasoning  | yes            | Error paths, health and status reporting, retries                               | Swallowed errors, fallbacks that mask a fault, a green that means nothing                                                 |
| Test integrity         | Reasoning  | no, deferrable | New or changed tests                                                            | Tests that pass without exercising the behaviour, and coverage that lies                                                  |
| Protocol correctness   | Reasoning  | yes            | This gate, the handoff's working protocol, any rule a later session must follow | Obligations removed or weakened, requirements no artifact can prove, and the cheapest review the new text permits         |

### What selection has measured

PR #30 is covered in [Keep the diff small](#keep-the-diff-small-because-the-diff-sets-the-price) and is
not restated here. This document's own precedent is that a duplicated lesson drifts and one copy goes
stale, so it gets one home.

PR #31, a dead-code sweep, took three. PR #32, two dependency-injection seams, took four. Both rounds
found real defects, so a reduced set is not a rubber stamp.

## Mutation is a command now

Owner decision, 2026-08-01. Every round up to #43 had the test-integrity lens invent its own mutation
set and run it by hand: 36 on #30, 51 on #32, 59 on #43. That is the most productive thing this gate
does and the worst possible use of an agent, because generating and executing mutants is mechanical,
non-reproducible between rounds, and self-reported. My own "10 of 10" on #43 did not survive contact
with the lens's 59, and neither number can be checked against anything today.

`pnpm mutate` runs [Stryker](https://stryker-mutator.io) from the repository root.

```bash
pnpm mutate
```

Scope it to what the diff touched, because the whole uploader is 1839 mutants against a 14-second
suite and that is an overnight run, not a pull request gate:

```bash
./node_modules/.bin/stryker run stryker.config.json --mutate 'packages/stream-uploader/src/engines/ome.ts,packages/stream-uploader/src/engines/ome/**/*.ts'
```

**On the command line scope with a comma-separated list. In the config use one array entry per
pattern. The two are not interchangeable and the same string in the wrong one matches nothing.**
`--mutate` is parsed with `createSplitter(',')` ([`stryker-cli.js:11`](../../node_modules/@stryker-mutator/core/dist/src/stryker-cli.js)),
so the CLI splits the value on every comma **before** any globbing happens. The `mutate` array in
`stryker.config.json` gets no such split, so a comma-joined string there is one glob pattern
containing commas and matches no file at all. Measured on 2026-08-01, and these are that day's counts
for this scope rather than an expectation to hold every future run against:

| pattern                              | on the CLI | as one config entry |
| ------------------------------------ | ---------- | ------------------- |
| `engines/ome.ts`                     | 1          | 1                   |
| `engines/ome/**/*.ts`                | 4          | 4                   |
| `engines/ome.ts,engines/ome/**/*.ts` | **5**      | **0**               |
| `engines/ome{,/**/*}.ts`             | **0**      | **5**               |

`engines/ome.ts` and `engines/ome/` are a sibling file and directory, and a recursive glob over the
directory never matches the file. The brace form is exactly inverted from the comma form, because its
own comma is what the CLI splitter destroys, leaving the two dead fragments `engines/ome{` and
`/**/*}.ts`.

That brace form was published here as the _fix_ for this trap, on the round that found the trap, and
it was never run.

**Check `Found N of M file(s) to be mutated` against a number you committed to before the run, and
treat the line's absence as the failure it is.** A run matching nothing does not print it at all:
Stryker logs that line only inside its non-empty branch, and the zero case takes a warning branch
instead. So the check most worth having is the one the line cannot perform. What a zero-match run
does print is `Instrumented 0 source file(s) with 0 mutant(s)` and
`No files found for mutation with the given glob expressions`, then **`Done` and exit 0**. Naming the
failure in a warning while exiting 0 is what makes it survivable, not silence.

The number matters more than the line, because the likelier mistake is not zero. Dropping `ome.ts`
and mutating only the directory prints `Found 4 of 258` and a plausible score, and every number
[R4](#r4-the-result-is-posted-not-just-discussed) requires is consistent with a healthy run. So R4
requires the `Found N of M` line verbatim in the posted result, and the selection comment states the
expected file count before the run, which is what makes the comparison an artifact rather than a
glance.

**The division of labour is the point.** Stryker generates, executes and reports. It cannot tell an
equivalent mutant from a real coverage gap, and it only ever mutates syntax. The lens receives the
survivor list and does the two things it alone can do: classify each survivor with a proof rather
than an assertion, which is the standard #43's lens met and earlier rounds did not, and add semantic
mutations no AST operator produces. The highest-value mutation of the whole #43 round was "shrink the
fix's floor to one segment", which is a change of meaning rather than of an operator, and it is what
exposed an acceptance test whose duration assertion could be satisfied by the wrong media entirely.

Four things about the setup that are load-bearing:

- **Stryker runs from the repository root, not from the package.** `srsWebhookAuth.test.ts` reads
  `engines/srs/srs.conf.template` three directories up, so a sandbox rooted at the package puts the
  test one level too deep and the initial run fails. Rooting at the repository keeps that deliberate
  cross-check against the real SRS template working.
- **`concurrency` is 4 and it is not a performance setting.** Eight concurrent copies of the suite
  failed 3 of 8 runs, in `GET /health status`, `OmeHlsPuller injected fetcher` and
  `StreamOrchestrator recovery-timer cancellation`. Four concurrent copies were clean across 8 runs on
  a 12-core machine. A flaky failure is scored as a killed mutant, so contention inflates the score
  and hides exactly the gaps the run exists to find. **This is why the score is not trustworthy in CI
  yet**, where the core count is lower and the same setting means more contention. TEST-24 has to
  close first, and it undercounts: it names two timing tests and there are three.
- **The command runner has no per-test coverage analysis**, so every mutant pays for the whole
  14-second suite. That is the price of `node:test` having no Stryker plugin, and it is why scope
  discipline matters more here than in a jest or vitest project.
- **A repeated `--mutate` on the command line replaces rather than appends.** Pass one glob, or set
  the list in the config.

What Stryker gives that the hand-rolled pass could not: it refuses to score a red baseline at all, it
writes a JSON report instead of a sentence, and the same code produces the same mutants next round, so
two rounds are finally comparable.

**The first run paid for the switch.** 132 mutants on `src/engines/ome.ts` **on 2026-07-31**, score
50.76, and among the 65 survivors was one that inverts the admission webhook's allow-or-deny decision
while all 294 tests stay green. Five gated pull requests had touched that file and none of them caught
it. It is now TEST-25. That file reached 172 mutants a day later, so read the count as the record of
one run rather than as what the next one should print.

**R2 still applies to the survivor list.** On that same run I read three survivors on
`if (!admissionSecret)` as the SEC-3 guard going untested, and it is a `logger.warn`. Twenty-two of
the sixty-five survivors were `StringLiteral` mutations of log text, equivalent by design. **A
survivor list is leads, not findings**, and each one is verified against the code exactly as a lens
finding is.

## A lens that gets expensive is a defect in this document

Owner rule, 2026-08-01, and it is standing rather than a one-off.

**When a lens starts costing too much time, the response is to change the process, not to absorb the
cost and not to quietly stop running it.** Those are the two failure modes, and the second is worse
because it looks like compliance. A gate nobody can afford is a gate that gets skipped, and skipping
it silently is exactly what the fail-closed clause exists to prevent.

The response is always the same shape: find the work the lens is doing that a command could do once,
move it to the command, and leave the lens the judgement. That is what happened to mutation, which
was an agent inventing and running its own mutants and is now `pnpm mutate`. It is what happened to
the claims auditor below.

**If nothing in a lens can be moved to a command, the cost is paid and the lens runs.** Seven of the
ten in the catalogue are the reasoning tier, which exists precisely because they cannot be
mechanised, so "nothing to move" is the ordinary case rather than the exception. **Cost is never a
reason recorded in the selection comment. Selection is by surface.** The one exception is the named
two-lens deferral in [what blocks a merge](#what-blocks-a-merge-and-what-only-files-a-row), which
moves when a lens finishes rather than whether it runs, is closed to exactly two lenses, and expires
on a recurring event. Extending it to a third lens is an owner decision. Read as anything wider, this
paragraph's own worked failure applies to it. Without that sentence this rule
reads as a licence: a session finds a lens expensive, finds nothing mechanisable, drops it, and
records the drop, which satisfies fail-closed and satisfies the ban on stopping quietly. Surface-driven
selection would become cost-driven one defensible drop at a time.

**The claims auditor's inputs come from `pnpm gate:facts`.**

```bash
pnpm gate:facts
```

It collects the suite counts, the check exit codes, the advisory counts, the diff's surfaces and
mutation applicability, and the publish age, signature and SLSA provenance of every version the
change introduces. The author pastes the block into the description.

**Three rules follow, and they belong in the prompt in this order.** The order is the point: the first
version of this section put regeneration in prose and made both prompt-ready bullets prohibitions, so
a session lifting the bullets would have written an auditor that reads a table and never compares
anything.

1. **Regenerate the block and diff it against the pasted one.** That is the verification. Investigate
   only the rows that disagree.
2. **Then spot-check at most a few rows against their own listed commands**, chosen because they look
   most likely to be wrong. A number is not true because a script printed it, and every row carries
   its command for exactly this. Do not re-derive the set.
3. **Author-measured rows are verdicted, not repeated.** A twelve-minute mutation run and a
   sixty-four-run flake sweep are declared by the author and marked as such. **UNVERIFIABLE is the
   correct verdict on those**, and reproducing one is a deliberate choice rather than the default.

**This narrows R3's method for the block, not its scope.** Every claim outside the block is still
extracted and verified normally, and the block is verified by regeneration rather than by
re-derivation. R2 is not amended either: regenerating is running a command, which is what R2 asks for.

**Fetch the description with `gh`. Never retype it into the prompt.** On the round that introduced
this section I handed the auditor a hand-abbreviated copy, so it audited a document that does not
exist and correctly reported a section missing that was present. A claims auditor reading the author's
summary of the author's own claims is not auditing anything.

**Four bounds, each of which the first version of this section was missing.**

**Some rows drift between the author's run and the auditor's, by design.** `published under 30 days
ago` is computed against the clock, so membership changes daily. The advisory count moves with
registry state. The suite counts move with contention, which TEST-24 and TEST-27 both document. **A
differing row is FALSE unless it is one of those three and the direction is explained**, and a row
marked failed in the regenerated block and not in the pasted one is always FALSE. Without that rule a
real regression gets absorbed as known flakiness, because a ready-made explanation is sitting in the
register.

**The block covers two of the owner's four dependency checks.** Publish age and signature-plus-SLSA
are collected. `npm audit signatures` is deliberately not, because it reads the installed tree rather
than the diff, and malware advisories are not collected at all. Both are **still owed by hand on any
lockfile change**, and the block says so in its own last row. A section that lists some checks reads
as listing all of them, and "do not re-derive the set" would otherwise turn the omission into a skip.
The register records why this matters: during SEC-7 the base branch sat on axios 0.30.3 with a
malicious 0.30.4 inside the range bee-js declares.

**The author-measured category is bounded.** A row belongs there only if the collector cannot take it
**and** it costs more than a few minutes, with the author naming the cost and the exact invocation
rather than prose. For a mutation run that means the numbers R4 already requires. **UNVERIFIABLE gets a
consequence it did not have:** a figure carrying that verdict may not be cited as evidence in the
register or in a later round without being re-measured. R3 requires correction for FALSE, MISLEADING
and STALE and says nothing about UNVERIFIABLE, so without this the category is a way to enter an
unchecked number into a merged description and cite it forever.

**The posted result carries the auditor's regenerated block verbatim.** R3 requires the description to
be corrected before merge, and a correction can change a fact row, so an auditor's "the block matched"
would otherwise sit against a block that has since moved. This is the same reasoning that already
keeps the lens selection out of the description.

The measurement that forced this: the PR #44 claims audit spent roughly 285k tokens, 115 tool calls
and 38 minutes, and almost all of it was recomputing numbers already measured. The cost was in the
prompt, not in the lens. It re-ran Stryker end to end, made two registry calls for each of 108
packages, ran `npm audit signatures` twice, ran `pnpm verify` and `pnpm build`, and ran the uploader
suite twice.

### The mutation check's price is the suite's runtime, multiplied

Owner intervention on PR #46, 2026-08-01: a mutation run reported 70 minutes remaining and the owner
stopped it. **Nothing about that run was misconfigured in the way this section usually means.** The
lens was not doing work a command could do, because Stryker is already the command. There was nothing
left to move.

The arithmetic is the whole finding. Stryker's command runner re-runs the **entire** suite once per
mutant, so the price is `suite runtime x mutants / concurrency`. At 14 seconds, 633 mutants and
concurrency 4, that is an hour. Measured the same day:

|                                                | runtime      |
| ---------------------------------------------- | ------------ |
| whole uploader suite, 17 files, 298 tests      | 14.0s        |
| `test/OmeEngine.test.ts` alone, 18 tests       | **12.2s**    |
| its two sibling OME files                      | 1.45s, 1.52s |
| a typical file, `test/utils.test.ts`, 39 tests | 1.3s         |

One file is 12 of the 14 seconds, and two tests inside it are 10 of that 12, each spending a full
`waitFor` deadline of `DELIVERY_TIMEOUT_MS = 5_000` on a condition that never comes true. The helper
never throws, so an expired wait is indistinguishable from a satisfied one and nothing has ever
reported it.

**Three things follow, and the first is the general one.**

**Suite runtime is a gate concern, not a nicety, from the moment a mutation check exists.** A slow
test is normally an annoyance costing seconds. Under mutation it is multiplied by the mutant count,
so ten wasted seconds became fifty wasted minutes. Scoping the mutants is the obvious lever and it is
the weaker one: it divides the multiplicand and leaves the multiplier alone.

**Cost is diagnosed by measurement, not by the first plausible story.** The first hypothesis here was
that the runner executes all 17 test files when only 3 can kill an OME mutant. It was wrong: cutting
14 files saved 0.9 seconds. The second was two misplaced waits: also wrong, removing them saved
nothing and broke both tests. Only timing each file found it. Both wrong answers were reasonable and
either would have been shipped as a fix on argument alone, which is [R2](#r2-verification-defaults-to-refuted)
applied to this document rather than to a lens.

**A wait that expires silently is the same defect as a check that exits 0 on nothing**, and this
section now holds one of each. `waitFor` returning normally on timeout, and a zero-match mutation run
printing `Done`, are one shape: a tool answering "fine" for "I did not do it".

## Lens prompt rules

Each of these came out of a round of this gate rather than out of general principle. They live here
because they are part of the protocol rather than part of any one round's notes.

**Read the figures below with their provenance.** This repository holds no measurement artifact: no token
log, no timing log, no recorded mutation set. The #30 mutation counts and the #29 token figures also
appear in the gate results posted on those pull requests, so they can be checked against something other
than this file. The #28 percentages and the #32 mutation count appear only in author-written documents,
and a document asserting its own measurement is not evidence. Treat an unchecked figure as a reason to
re-measure rather than as a settled number. Each rule stands on the finding its round produced, which is
checkable, rather than on the size of the number attached to it.

- **Run the claims auditor first and alone**, before the code lenses. Twice in one session a test count
  went stale mid-review and invalidated the description after the code lenses had already finished.
- **Tell the claims auditor that "the file exists" is not evidence, and that UNVERIFIABLE is the correct
  verdict when the available evidence falls short.** On #27 and #28 it returned TRUE twice on evidence
  that established nothing. With that sentence added, on #29 it correctly refused to verify a
  measurement it could not reproduce. This is the highest value per word of anything found so far.
- **Give the test-integrity lens mutation as its method, not reading.** On #30 it ran 36 mutations and
  named, for each survivor, an assertion that did not assert what its title claimed. On #32 it ran 51
  and found that a test written to document a missing timeout would have stayed green once the timeout
  landed. Reading the files produces neither result. **The lens no longer generates or executes the
  mutants** (see [Mutation is a command now](#mutation-is-a-command-now)). It receives the survivor
  list and does the part only it can do.
- **Verify the reviewer's proposed fix, not only its finding.** Already required by R2, and worth
  repeating in the prompt. On #29 the auditor correctly spotted an imprecise sentence, then proposed a
  rewording wrong in the other direction, turning a real event into a hypothetical one.
- **Forbid lenses from reading `docs/reviews/` and the branch's commit messages, and tell them to exclude
  `docs/` from repo-wide greps.** On #30 two lenses disclosed that an early `grep -i health` had printed
  register lines into their transcripts. Both re-derived their findings from source and said so, which is
  the behaviour you want, and the exposure is still avoidable with one sentence. **The files under review
  are excepted.** When the diff is inside `docs/reviews/`, those files are the artifact and R1's grant of
  the diff wins, so the ban narrows to whatever in that directory the diff does not touch, plus the
  commit message bodies. Without that sentence this rule and R1 contradict each other on exactly the pull
  requests that amend this document, which is how it was found.
- **Give every lens the head sha explicitly**, and say that the working directory may have the base
  branch checked out. On #32 one lens spent a pass measuring base content.
- **Lenses that mutate source cannot share a working tree.** Isolate or serialize them, and **do not
  commit while they run**. On #34 five lenses ran concurrently in one checkout, two of them mutating
  `OmeHlsPuller.ts`: the test-integrity lens's mutate-and-restore cycle discarded the correctness lens's
  uncommitted draft fix, and only that lens noticing and re-running every surviving mutation on a
  verified-clean tree kept its numbers honest. Meanwhile the author's docs commits moved HEAD under all
  five mid-run. Each detected it and confirmed the source was untouched, which was luck rather than
  design.
- **Give every lens the scratchpad path and forbid worktrees inside the repository.** Lenses have created
  them anyway, one holding the integration branch checked out, which blocked a merge until it was
  detached. Run `git worktree list` before merging rather than after it fails. The author-side half of
  this: stage explicit paths while lenses are running, because a `git add -A` swept one lens's leftover
  probe directory into a commit.
- **Instruct lenses to run `tsc` with `--noEmit` and never to name files on the command line.** Naming
  files silently ignores `tsconfig.json`. One lens emitted 15 `.js` files beside the sources and turned
  `pnpm lint` red while every tracked file was clean.
- **A neutral orientation brief** covering repo layout, test commands and known traps reveals nothing
  about the expected answer, so R1 still holds with it. Not a uniform win: on #28, the round that
  introduced it, it cut the test lens 20% on tokens and 38% on time and cost the security lens 19% more.
  Keep using it and keep watching.
- **The mechanical lenses do not need the top model tier**, and the tier table above is what says which
  those are: the claims auditor and mutation triage. This bullet used to name test integrity among
  them, which now contradicts the table's classification of it as a reasoning lens, and nothing in R4
  records which tier a lens actually ran at, so the divergence would be undetectable afterwards. The
  measurement behind the rule stands: on #29's 13-line config diff, three lenses a tier down cost 49k,
  34k and 29k tokens against roughly 50k to 70k each at full tier, and the cheap ones still produced a
  byte-level `.gitignore` check and a per-package `outDir` comparison. **That was a config diff, so do
  not assume it holds on a logic-heavy one without checking**, and that caveat travels with the numbers
  wherever they are quoted, including the tier section above.

## Fail closed

If a lens you selected did not run, the gate is **not satisfied**, exactly as if the outside reviewer
had never posted. Do not merge, and do not record the sprint exit gate as met.

Per-PR selection weakens this clause unless the selection itself is on the record, because a list that
shrinks can always be made to look complete afterwards. "The gate ran" has to name which lenses, or it
asserts nothing.

So the selection gets its own artifact. **Post the selection and its reasoning as a pull request comment
before launching a single lens.** Not in the description: R3 requires the description to be corrected
before merge, so every correction destroys the timestamp evidence that the selection predated the run.
A comment is immune to that, because R3's corrections land on the description. The comment's timestamp
against the posted result's is then something a later reader can check, which is the whole point.

## What this gate does not give you

Stated plainly rather than papered over, because someone will otherwise read a passing gate as more
assurance than it is.

Every lens here is the same model family as the author. A blind spot shared across that family is
invisible to all of them at once, no matter how many lenses run, and no amount of adversarial
prompting fixes it. Three things reduce the exposure without closing it: lenses that ask genuinely
different questions, verification against ground truth by running commands rather than by
deliberating, and the repo owner's review, which remains the real backstop for anything this gate
clears.

So a passed gate does not mean "reviewed and approved". It means the diff survived a named set of
lenses, every surviving finding was answered, and the claims in the description were checked against
reality. Describe it that way, including in the progress log.

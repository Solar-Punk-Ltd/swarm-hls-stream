# Review gate

Standing protocol. Every pull request into `feat/ai-hardening` passes this before it merges.

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
that were selected against, what was confirmed, what was refuted and why, and what changed as a result.

**When the mutation check ran, the result also carries its exact `stryker` invocation, the mutant
total, the survivor total, the score, and the `concurrency` and host core count it ran at.** Four
lines, and without them the check has no artifact at all: the JSON report is gitignored, so scoping
the run to one file out of five is undetectable by the triage lens, which is forbidden from generating
its own mutants and is never told the scope. The claim that two rounds are finally comparable is only
true if the numbers are posted somewhere immutable. The concurrency and core count belong there
because a flaky failure scores as a killed mutant, so a run on a smaller machine reports a better
score for a worse suite.
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

**The harness covers `packages/stream-uploader` and nothing else.** `stryker.config.json` mutates that
package's `src/` and runs that package's suite. `audit-gate`, `cli` and `client` all have `src/` and
none of them has a runner here, so a change to `packages/cli/src/` gets recorded as **unavailable**,
which is a different word from not applicable and must not read as coverage. Mutating unscoped would
report on a package the diff never touched, and mutating `cli` with the uploader's suite would survive
every mutant and produce pure noise.

**Not applicable means genuinely neither**, as on a docs, deploy or CI diff. The selection comment
states which of the three it is, and the claims auditor verifies that statement, because it is a
binary fact one `git diff --name-only` settles and R3 otherwise never looks at the selection comment.

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

| Lens                   | Tier       | Select when                                                                     | Hunts                                                                                                                     |
| ---------------------- | ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Claims audit           | Mechanical | **Always**                                                                      | Assertions in the description that were never checked, or are stale                                                       |
| Mutation triage        | Mechanical | **Any `src/` change.** Stryker generates and runs, the lens only triages        | Survivors that are real coverage gaps rather than equivalent mutants, and the semantic mutations no AST operator produces |
| Correctness            | Reasoning  | Any logic change                                                                | Wrong output for specific inputs, false green, false red                                                                  |
| Security               | Reasoning  | Input handling, auth, filesystem paths, CI, dependencies                        | A concrete attack path with a named attacker and what they control                                                        |
| Concurrency            | Reasoning  | The orchestrator, queues, timers, recovery                                      | Interleavings that corrupt state, lost updates, races between entry points                                                |
| Behaviour preservation | Reasoning  | Refactors, autofixes, anything claimed to be mechanical                         | Hunks where behaviour actually differs from the version they replaced                                                     |
| Config consistency     | Reasoning  | Config, scripts, CI, packaging, docs describing commands                        | Two things in the repo that disagree, and what breaks because they do                                                     |
| Silent failure         | Reasoning  | Error paths, health and status reporting, retries                               | Swallowed errors, fallbacks that mask a fault, a green that means nothing                                                 |
| Test integrity         | Reasoning  | New or changed tests                                                            | Tests that pass without exercising the behaviour, and coverage that lies                                                  |
| Protocol correctness   | Reasoning  | This gate, the handoff's working protocol, any rule a later session must follow | Obligations removed or weakened, requirements no artifact can prove, and the cheapest review the new text permits         |

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
./node_modules/.bin/stryker run stryker.config.json --mutate 'packages/stream-uploader/src/engines/ome{,/**/*}.ts'
```

**`engines/ome.ts` and `engines/ome/` are a sibling file and directory, and a `dir/**/_.ts`glob
matches only the second.** The obvious`engines/ome/\*\*/_.ts`takes 4 files and 461 mutants while
silently skipping`ome.ts`, which is the file that produced TEST-25. Check the "Found N of M files to
be mutated" line against what you expected before letting a run stand.

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

**The first run paid for the switch.** 132 mutants on `src/engines/ome.ts`, score 50.76, and among the
65 survivors was one that inverts the admission webhook's allow-or-deny decision while all 294 tests
stay green. Five gated pull requests had touched that file and none of them caught it. It is now
TEST-25.

**R2 still applies to the survivor list.** On that same run I read three survivors on
`if (!admissionSecret)` as the SEC-3 guard going untested, and it is a `logger.warn`. Twenty-two of
the sixty-five survivors were `StringLiteral` mutations of log text, equivalent by design. **A
survivor list is leads, not findings**, and each one is verified against the code exactly as a lens
finding is.

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

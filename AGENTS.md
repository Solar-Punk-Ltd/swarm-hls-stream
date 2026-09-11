# Working rules for this repository

## ⛔⛔⛔ Never engineer around money

**Owner rule. It overrides any instinct to be careful with the balance, and it overrides a previous
session's judgement written into a doc, a roadmap or a comment.**

> _"it's really annoying that you constantly blocking crucial tests because it costs BZZ please
> forget this. We have bzz plenty. Let me know the spending and I approve but do not design around
> because it's expensive. Really not cool"_ (2026-08-12)
>
> _"okay, well anytime I can send more don't whitstand tests because you think this is all we have"_
> (2026-08-29)
>
> _"write a rule in repo that you don't have to engineer around money. I can send any time the
> amount you need for proper tests or measurements."_ (2026-08-30)

### What this means in practice

**Size the work from the question, never from the balance.** How many arms, how many replicates, how
long a broadcast, how many rungs. Decide all of it from what would actually settle the question, then
report what it costs in the same message as the plan, then run it.

**A cheaper experiment that cannot settle the question is not thrift, it is waste.** An n=1 arm
shipped with a caveat costs the same broadcast and answers less. Repeating always beats a warning.

**If the pot is short, that is a sentence, not a redesign.** Say the amount needed, hand over the
exact command, and carry on planning the run that answers the question. The owner sends funds at any
time and does not need to be asked twice.

**Never write any of these as a reason to stop:** "deferred because it costs BZZ", "needs funds",
"no longer free", "we should wait until there is more headroom", "a smaller version to fit the
budget". Price it and say so instead.

**Never quietly run a smaller sitting and report it as the answer.** That is the failure this rule
exists to prevent. Scaling work down is the owner's call, never the agent's.

### What this rule does NOT change

⛔ **The agent never moves money.** No deposit, no top up, no dilute, no buy, no send. Write the exact
command, hand it over, stop. The owner runs it from their own shell. This is a mechanic and it is
never a reason to shrink anything.

⛔ **A spend ceiling is the owner's to set.** `.spend-ledger.env` carries the authorisation and the
gates in `deploy/scripts/` read it before a publisher starts. **Never rewrite the ledger to make your
own plan pass.** A night that does not fit the authorised ceiling stays a night that does not fit,
and the answer is to ask for a higher one, not to edit the file.

⛔ **Cost is still worth measuring and reporting as a product fact.** What a broadcaster pays per hour
is a real number this project exists partly to establish. That is completely different from letting
the balance shape a test plan.

### Before ever saying funds are short

Read **both** balances on the uploader's bee API. The wallet usually holds BZZ outside the chequebook,
so more headroom is often a move rather than a send:

```bash
ssh manager-host 'curl -s http://127.0.0.1:10075/chequebook/balance; echo; curl -s http://127.0.0.1:10075/wallet'
```

Since the per-rung split of 2026-08-31 that command reads ONE node of four, the coordinator. Each
rung publishes through its own bee with its own chequebook and wallet, so read all of them before
any funds statement (ports 10075, 11071, 11073, 11075, plus the gateway 10077):

```bash
ssh manager-host 'for p in 10075 11071 11073 11075 10077; do echo "== $p"; curl -s http://127.0.0.1:$p/chequebook/balance; echo; curl -s http://127.0.0.1:$p/wallet; echo; done'
```

The chequebook preflight and `pnpm e2e:smoke` print the same readings per node. (Amended
2026-09-02 after the stamp gate closed the same one-node blindness on the postage side.)

⚠️ Watch `availableBalance`, never `totalBalance`. They differ because `available = total - outstanding
cheques`, so a peer cashing a cheque the node already wrote moves total without anything being spent.

## ⛔ An e2e suite checks correctness, never performance

Owner rule of 2026-08-29. A suite under `e2e/suites/` asserts that a feature works and stays stable.
It never gates on a timing.

Durations, latencies, freeze lengths and recovery times are **measured on every run, printed under a
heading that says `observations, none of them asserted`, and filed in the artifact**. None of them
refuses a run. A threshold carried across a configuration change is a number about a different
deployment, and this project has already spent runs failing correct code against ceilings measured on
a stack that no longer exists.

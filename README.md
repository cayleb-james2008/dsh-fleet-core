# DSH Fleet core

[![test](https://github.com/cayleb-james2008/dsh-fleet-core/actions/workflows/test.yml/badge.svg)](https://github.com/cayleb-james2008/dsh-fleet-core/actions/workflows/test.yml)

Three mechanisms from a six-seat agent fleet that has run more than a hundred
ticket missions: admission control, a checker gate, and provider rotation. Each is a standalone ES module with no dependencies. The tests run
on Node 20+ with nothing installed.

This is a curated cut, not the fleet. The mission store, Slack intake, web face,
memory, tools and the orchestration module that composes briefs and runs the swarm
lifecycle are not here. What is here are the three decisions that are easiest to judge on their own, and the three that kept the system honest when it failed.

```bash
npm test          # 32 tests, no dependencies
npm run demo      # a green gate and a red gate, end to end
```

There is no build step. There is no API key. Nothing in the test suite touches
the network.

## Why these three

The fleet is a set of agent sessions working a queue of tickets on one machine.
A ticket is a goal, a done-when, and a lane. A lead plans it, workers build it,
and a fresh checker decides whether the ordered done-when actually holds. The
three mechanisms cover the three places where that design can go wrong:

1. **Too much work starts at once.** Admission turns the owner's concurrency
   ruling into a pure decision: six ticket swarms, load-gauge before a start,
   heavy jobs weigh more than one slot. It can only postpone a start. It never
   kills, pauses or parks a running ticket.
2. **The builder grades its own work.** The checker gate sets aside any verdict
   from an earlier round, records the instant the round began, and accepts only
   a verdict written after it. The verdict is the last line-anchored `VERDICT:`
   in the file. A quoted `PASS` in the prose is not the verdict.
3. **One provider runs out.** The router pins a provider and model for every
   spawn, falls back along the owner's rotation when a pool is spent or a key is
   rejected, and records the fallback. A banned model is never a candidate,
   whatever the catalogue calls it.

## 1. Admission control

The rule is a ceiling on **ticket swarms**, not on agent sessions. Six swarms
may run. A seventh start waits. Under the ceiling, a start also needs real CPU
and RAM headroom, and a heavy job (a build, a render, a video) costs two or
three of the six weighted slots.

```js
import { decideStart, measureGauge, runningLoad } from './src/index.js'

const running = runningLoad({ missions: fleet.missions })
const decision = decideStart({
  state: { running, gauge: measureGauge() },
  weight: 1,
})

// { admitted: false, code: 'cap',
//   reason: '6 of 6 ticket swarms running — the 7th ticket start is queued', ... }
```

The decision order is fixed: **cap**, then **load**, then **weight**. The cap is
a count, so it comes first even when every job is light. The gauge is a real
reading of `/proc/meminfo` and `os.loadavg()`, injectable so a test or a
contained proof can use a synthetic machine instead of the desktop it protects.

`admissionState()` wraps the same functions for a panel: one headline, the
running list, the queue, and the rule with its weights and provenance.

The module is admission-only **by construction**. It has no stop, pause or park
function. Parking at a safe checkpoint stays a deliberate lead act, because the
ruling names the lead, not the gate.

## 2. The checker gate

The most expensive failure in an agent fleet is a confident `DONE` on work that
does not hold. The gate is deliberately narrow: it does not decide whether the
work is good. It decides whether a **fresh** checker actually decided.

```js
import { runVerifyGate } from './src/index.js'

const result = await runVerifyGate({
  workspace,
  command: 'bash verify.sh',          // the ticket's ordered done-when
  checker: async ({ workspace, commandResult }) => {
    // A fresh checker runs the command itself, reads the raw artefact,
    // and writes verdict.md. The builder's report is not an input.
    writeFileSync(join(workspace, 'verdict.md'), 'VERDICT: PASS\n')
  },
})

if (!result.ok) process.exit(1)
```

What the gate guarantees:

- **Stale verdicts are set aside before the round.** A `verdict.md` left by a
  previous round is renamed, so it cannot be read as this round's judgement.
- **Freshness is checked against the round's start**, with a 2-second tolerance
  for file-system mtime resolution. A verdict older than the round is a FAIL
  that says so, not a PASS.
- **The last line-anchored verdict wins.** The rule exists because a real fleet
  once marked two failing artefacts done when the parser took the first `VERDICT: PASS` it found, a line quoted from an earlier mission, while the file's own final line said `FAIL`.
- **The command output is evidence, not a verdict.** A checker that writes
  `PASS` over a failing command is still a bad checker; the gate records the
  command result and preserves it in the round.

`npm run demo` runs both directions: a fresh PASS is accepted, and a stale PASS
with the artefact deleted is refused.

## 3. Provider rotation

Every spawn pins one provider and model. The owner names two picks — `main` for
the agent that takes the ticket, `subAgent` for the agents it delegates to — and
a rotation list supplies the fallback chain.

```js
import { createMemoryStore, createRouter } from './src/index.js'

const store = createMemoryStore()
const router = createRouter({ store })

router.setModelSelectors({ main: { provider: 'acme', model: 'model-a' } })
router.setRotation([
  { provider: 'acme', model: 'model-a' },
  { provider: 'beta', model: 'model-b' },
])

router.routeFor('main')          // acme/model-a, pinned, fellBack: false
router.routeFor('main', { index: 1 }) // beta/model-b, fellBack: true
```

The rules that matter:

- **A pick is a pin.** If the owner has not picked, the router seeds from the
  app's current default; if that is impossible, it refuses rather than spawning
  an unpinned agent.
- **Fallback is recorded, never silent.** A route that is not the owner's pick
  has `fellBack: true`, and the routing audit records the pools it saw.
- **A spent pool is routed around.** The face's "mark this pool as spent"
  toggle is a routing fact, not a usage counter; a spent head is left out of its
  own chain. When the chain is empty the router throws a plain refusal.
- **Bans are shape-based.** A model id that names `fable` is banned even if the
  catalogue invents a new id. A route allow-list can restrict a provider to
  named models without banning the model globally.
- **Failures are classified once.** A 429 or quota error marks a route
  exhausted; a 401/403 marks it rejected and later spawns skip it. An ordinary
  socket error is not a routing fact.

## What the fleet learned

The mechanisms above are the surviving shapes of real failures. A short tour:

- A checker file that quoted another mission's `PASS` was read as this
  mission's verdict. The fix is the last-line rule in `src/gate.js`.
- A checker round that produced no verdict was read as a verdict on the artefact. The gate reports `the checker wrote no verdict file` instead, which is a statement about the round, not the work.
- A rotation entry marked `spent` was read as a provider quota fact. It is an
  operator toggle. The router treats it as routing state and never as a usage
  counter.
- A model that was registered and whose key was accepted still returned `404
  Function not found for account` on the first real completion. A route is not
  a route until a real turn succeeds on it.
- A front end passed its checker and still could not be used. A screenshot is
  not a flow. The fleet's video evidence rule came from that.

The companion write-up, *What 88 tickets on a 6-seat agent fleet taught me*, is
in review. It carries the full digest and the failures with their sources. It
will be linked here when it is published.

## What is deliberately not here

- The mission store and its on-disk layout.
- The Slack bridge and its intake parser.
- The web face, the roster, the bus and the tool registry.
- The scheduler and the orchestration module that composes briefs, spawns
  sessions and runs the swarm lifecycle.

Those are the fleet. This repo is the core that can be read in an afternoon.

## Provenance

The modules were extracted from a live fleet plugin tree on 9 November 2026,
then made standalone: imports trimmed, adapters injected, comments rewritten,
tests written for this repo. `PROVENANCE.md` records the source file hashes and
the lines each module was cut from. `SCRUB.md` records the secret and
personal-path scan that ran before the first public commit.

No third-party code is vendored. No credentials, tokens or fleet state are in
this repository.

## Security

This is a reference extraction. It reads the local machine's load average and
memory, runs a caller-supplied shell command, and writes files in a
caller-supplied workspace. Do not expose it as a service without putting your
own sandbox around it. See `SECURITY.md`.

## License

MIT. See `LICENSE`.

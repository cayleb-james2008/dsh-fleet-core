# FLEET.md — the canonical definition of the fleet

This file is `FLEET.md`, the single living definition of the fleet. It is the
file future work reads first, and it is updated only by PR.

## What the fleet is

The fleet is Cayleb's agent workforce inside the DeepSeek Harness. It is
dynamic and task-shaped: for each ticket it forms a swarm sized to the work,
then dissolves. There is no standing bench — no fixed roster of agents
waiting to be assigned.

## How work flows

**Intake.** Work arrives ONLY as tickets in Slack #tickets. Every ticket carries
GOAL / CONTEXT / DONE-WHEN. No other intake exists.

**Swarm.** The ticket is handed to a Lead, who plans and shapes a swarm for that
ticket alone: makers build, checkers verify.

**Maker / checker.** Maker never checker. Every output is RUN by a fresh checker
that executes and inspects the artefact itself; a checker never trusts the
maker's report.

**Outcome.** Every ticket ends in exactly one outcome: DONE, BLOCKED, or ERROR.

```
intake (#tickets ticket) → swarm (lead + makers) → checker runs the output → DONE / BLOCKED / ERROR
```

## Standing laws

1. **PRs only.** No direct pushes to protected branches. Every change lands by
   pull request against the protected branch.
2. **Model ladder.** Haiku is the default. Sonnet leads tickets. DeepSeek V4.1
   Flash with MAX reasoning sits on the volume seats. Opus and Fable are used
   only as pinned, explicitly-promoted assignments.
3. **Nox grades first.** Nox is the grader of record. Passed work closes on
   Nox's grade without waiting on the owner — a pass closes on Nox's grade, not
   on Cayleb's attention.
4. **No new repositories.** NO new GitHub repositories without Nox's written
   approval in the ticket thread.
5. **Ponytail.** Ponytail is the default discipline: the smallest change that
   works.

## Channels

- `#tickets` — intake. Tickets arrive here.
- `#fleet` — the owner room.
- `#brains` — direct comms.

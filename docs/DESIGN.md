# The three decisions

This note explains why the three modules look the way they do. It is design
history, not a tutorial. The README covers the interface.

## Admission is a count first, a gauge second, a weight third

The owner's ruling was a machine-load rule, not a permission gate: six ticket
swarms, no new start while six run, running tickets never killed, heavy jobs
count as more than one slot, and if the load stays critical the **lead** parks
the lowest-priority runner at a safe checkpoint and says so in the ticket.

The important design choice is what the gate does **not** do. It does not park,
pause or kill. A gate that can stop work is a scheduler; a gate that can only
postpone a start is an admission rule. Keeping that boundary means the decision
can be a pure function, tested with a synthetic machine, and still match the
ruling.

The order of the checks matters. The cap is a count. A heavy job cannot buy its
way past a full house, so the cap is checked before the gauge; the gauge is
checked before the weight, because a hot machine refuses even a light start. The
weights are part of the rule, not a tuning knob: a video job costs three of six
slots because it really does.

A real bug produced the headline-only classifier. The first version scanned the
whole order for heavy-job words, and every front-end ticket carries the fleet's
standing "walkthrough video" evidence requirement in its order text. On one
morning 17 of 20 tickets classified as video jobs and the six-seat ceiling could
never run more than two. The headline is the honest signal of what the job is;
the order's boilerplate is what evidence every job owes.

## The gate only decides freshness, because the checker decides truth

The host cannot know whether an artefact is good. It can know whether a fresh
checker actually wrote a verdict this round. That is the separation:

- the **checker** runs the done-when, reads the artefact and decides;
- the **gate** sets aside old verdicts, timestamps the round, and accepts only a
  new file.

Everything else follows from that. A maker's report is a claim to be doubted,
never evidence. A checker's session that dies without writing a verdict is a
statement about the session, not about the artefact — the gate says "no verdict
file", which is exactly what happened.

The last-line rule came from a live false DONE. A verdict file quoted an earlier
mission's `VERDICT: PASS` in its prose and ended with its own `VERDICT: FAIL`.
The parser took the first match, and two failing artefacts were marked done. The
fix is small and permanent.

## A route is a fact, not a default

The router exists because "the model" is never one thing. The owner has a main
pick and a sub-agent pick; the rotation is the fallback chain; a pool can be
spent; a key can be rejected; a route can allow only one model; and a model id
can be banned by shape.

The two failure modes that shaped it:

1. **Silent substitution.** A spawn that quietly runs a different model than the
   owner picked is a lie about the system. Every route is pinned, and a route
   that is not the pick carries `fellBack: true` plus an audit entry.
2. **Confusing routing state with usage state.** A "mark this pool as spent"
   toggle in the face is an operator decision, not a provider quota. It is
   stored on the rotation entry and routed around; the usage map is reporting,
   not routing. Mixing the two made a one-entry rotation with `spent: true`
   empty the chain and refuse every spawn with a message that looked like a
   quota error.

The ban list is shape-based on purpose. A catalogue can invent a new id for the
same family; an exact-match ban would let it through.

## What is not solved here

- The gate does not verify that the checker was independent, only that its
  verdict is fresh. Independence is a session-spawn property of the host.
- The router does not know whether a route is entitled for the account until a
  real turn succeeds. A registered model with an accepted key can still answer
  `404 Function not found for account`.
- Admission does not measure per-job memory. The gauge is machine-wide.

Those are real limits. They are written down because a harness that hides them
is less useful than one that names them.

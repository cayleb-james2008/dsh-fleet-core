# Provenance

This is a curated extraction from a private fleet plugin tree. It is not a copy
of the whole tree, and it is not a rewrite from a description: the three modules
below were cut from source files that were running in a live fleet on 9 November
2026.

Source tree state at extraction: **2026-11-09T17:45Z** (the private plugin tree
was not a clean Git checkout at that moment, so the source is pinned by file
hash rather than by commit).

| Module | Source | Source sha256 | What changed |
|---|---|---|---|
| `src/admission.js` | `src/host/admission.js` | `0c2a88969ad1a7f9e4869b8ff8a3c5604a8742c716a6335a75ead24f70c9ce6b` | Copied whole. The owner named in comments became "the owner"; the internal channel reference in `ADMISSION_SOURCE` was dropped. No behaviour change. |
| `src/router.js` | `src/host/engine.js` — the selector, rotation, chain, route, failure and ban functions | `8723222e959d744bf2521e999d57ca26d47f3e1c1538ec5836c3ab178486bb85` | Extracted from `createEngine`. The host's `ctx`, `store` and `pools` are now injected. The app's own default selection is an injected function instead of a host service. The legacy list-based `route()` is kept. |
| `src/gate.js` | `src/host/fleet.js` — `checkerBrief` (L2154–L2211), `checkMission` (L2213–L2292) and `parseVerdict` (L2335–L2366) | `3542577507ac51385915ddec5d58b74a2e42ebbd7a89b747da10d2b5608b43f7` | The mechanical half only: stale-verdict set-aside, freshness check, last-line verdict parse, command execution. The session spawn, model route and retry loop belong to the fleet host and are not here. The stale/file operations and the command runner are injectable. |

The tests, README, examples and the design note were written for this
repository. They are not extracted.

## What was deliberately left behind

The extraction drops every part that depends on the harness host: the mission
store, Slack intake, the web face, the bus, the tool registry, the scheduler and
the swarm lifecycle. Those are the fleet. The three modules here are the parts
that can be read without the host and still show how the system stays honest.

## Third-party code

None. The modules import only `node:` builtins.

# Security

This repository is a reference extraction. It is not a service and it is not
connected to the fleet it was cut from.

## What the code does that deserves care

- `src/admission.js` reads the local machine's load average and available
  memory.
- `src/gate.js` runs a caller-supplied shell command with `bash -lc` in a
  caller-supplied working directory, and writes/renames `verdict.md` there.
- `src/router.js` holds model ids and makes routing decisions. It does not make
  network calls and does not read credentials.

Do not pass untrusted input to `runVerifyGate`'s `command` or `workspace`. Put
your own sandbox around the process if you expose it to anyone else.

## Secrets

The repository contains no credentials. The history was created in one public
push from a tree that was scanned before the push; see `SCRUB.md`. There is no
`.env` file, no token, no fleet state and no personal absolute path in the tree.

## Reporting

Open a private security advisory on this repository rather than a public issue.
There is no bug bounty.

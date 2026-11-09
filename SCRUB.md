# Scrub report

This repository is a curated cut from a private fleet. Before the first public
push, the tree was scanned for credentials, personal paths and account detail.

## Method

A custom scanner (`scrub-scan.mjs`, run from outside the repo and not shipped
here) walks every text file under 2 MB, skips `.git`, `node_modules` and
lockfiles, and matches these classes:

- Slack tokens (`xox[baprs]-…`), Slack session tokens (`xoxc-…`) and Slack IDs
  (`U0…`, `C0…`, `W0…`);
- GitHub tokens and personal access tokens, OpenAI-style keys, NVIDIA NIM keys,
  Google API keys, AWS access key ids;
- private-key blocks and long bearer tokens;
- absolute personal paths (`/home/<user>`, `/Users/<user>`) and the fleet's
  private state directory;
- email addresses.

It prints the pattern name and `file:line` only. It never prints the matched
text, so the scan log itself cannot leak a secret.

It ran over the 17 text files in this tree and returned **0 findings**.

## What was deliberately never copied

- The fleet's state files, mission records, session transcripts and audit log.
- The Slack bridge's token/auth files and channel identifiers.
- The live plugin tree's environment, local paths and uncommitted state.
- Trading-account detail: no trading code or account data is in this cut.

## Limits

- This is a pattern scan, not a proof of absence. It cannot catch a secret that
  does not match a known shape, or one encoded in an image.
- `gitleaks`, `trufflehog` and `detect-secrets` are not installed on the host
  that produced the cut, so no scanner with a curated rule set was available.
  The method and its limits are stated rather than implied.
- The repository history starts at the first public commit. There is no earlier
  private history in this repository that could contain an old secret.
- The GitHub account name in the `repository` field is intentionally public. The
  package author name is the repository owner's public name. Neither is a
  credential.

## Re-running

The scanner is not part of the repo. To reproduce the check, use any
secret scanner over the tree; the tree contains only source, tests, examples,
docs and the standard licence/CI files.

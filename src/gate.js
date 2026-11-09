/**
 * The checker gate — how an agent fleet accepts work without grading its own
 * homework.
 *
 * A builder finishes an artefact and writes a report. A *fresh* checker, which
 * did not see the work being done, runs the ordered done-when command itself,
 * reads the raw artefact, and writes `verdict.md` ending in one line:
 *
 *     VERDICT: PASS
 *     VERDICT: FAIL — <specific finding>
 *
 * The host's job is narrower than the checker's, and this module is that job:
 *
 *   1. set aside any `verdict.md` left by an earlier round, so a stale file can
 *      never be mistaken for this round's judgement;
 *   2. record the instant the round started;
 *   3. run the done-when command (or let the checker run it) and keep the output;
 *   4. accept only a verdict file written *after* the round started;
 *   5. read the LAST line-anchored verdict line, never the first. A verdict file
 *      may quote another mission's PASS in its prose; the quoted line is not the
 *      verdict.
 *
 * The maker's report is never input to the decision. It is a claim to be
 * doubted.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'

/**
 * How far a verdict's file mtime may trail the recorded start instant. File
 * systems can have coarser mtime resolution than Date.now(), so a verdict
 * written in the same millisecond the round began must not be called stale.
 */
export const CHECKER_VERDICT_MTIME_TOLERANCE_MS = 2000

/**
 * Read one verdict line out of a checker's output.
 *
 * THE LAST VERDICT LINE WINS. The rule exists because a real fleet marked two
 * failing artefacts DONE when the parser took the first match: the verdict
 * files quoted earlier missions' "VERDICT: PASS" lines while their own final
 * line said FAIL. A line-anchored verdict always beats an inline mention; an
 * inline mention is only a fallback for a malformed file.
 */
export function parseVerdict(output) {
  const text = String(output ?? '')
  const lineAnchored = [...text.matchAll(/^\s*(?:\*\*)?VERDICT:\s*(PASS|FAIL)(?:\s*[—-]\s*(.*))?/gim)]
  const anyMatch = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)(?:\s*[—-]\s*(.*))?/gi)]
  const chosen = lineAnchored.length > 0
    ? lineAnchored[lineAnchored.length - 1]
    : (anyMatch.length > 0 ? anyMatch[anyMatch.length - 1] : null)
  if (chosen === null) {
    return {
      pass: false,
      finding: text.trim().length === 0
        ? 'the checker wrote no verdict file'
        : 'the checker wrote a verdict file with no verdict line',
      raw: text.slice(0, 2000),
    }
  }
  const pass = chosen[1].toUpperCase() === 'PASS'
  return {
    pass,
    finding: (chosen[2] ?? '').trim() || (pass ? 'the ordered done-when holds' : 'the checker failed the artefact'),
    raw: text.slice(0, 2000),
  }
}

/** The default file operations, kept injectable so the gate can be tested cold. */
export const realIo = {
  existsSync: (path) => fs.existsSync(path),
  statSync: (path) => fs.statSync(path),
  readFileSync: (path) => fs.readFileSync(path, 'utf8'),
  renameSync: (from, to) => fs.renameSync(from, to),
}

/**
 * Move one stale verdict out of the way. Returns the path it was moved to, or
 * undefined when there was nothing stale.
 */
export function setAsideStale(verdictPath, label, io = realIo) {
  try {
    if (!io.existsSync(verdictPath)) return undefined
    const aside = `${verdictPath}.stale-${String(label).replace(/[^a-zA-Z0-9-]+/g, '-')}`
    io.renameSync(verdictPath, aside)
    return aside
  } catch {
    return undefined
  }
}

/**
 * Read the verdict this round actually wrote. A file that is missing or older
 * than the round's start is NOT a verdict: it is a FAIL with a finding that
 * says which.
 */
export function readFreshVerdict({ workspace, startedAt, io = realIo }) {
  const verdictPath = join(workspace, 'verdict.md')
  if (!io.existsSync(verdictPath)) {
    return {
      pass: false,
      finding: 'the checker wrote no verdict file',
      raw: '',
      fresh: false,
      path: verdictPath,
    }
  }
  const mtimeMs = io.statSync(verdictPath).mtimeMs
  const fresh = mtimeMs >= startedAt - CHECKER_VERDICT_MTIME_TOLERANCE_MS
  const raw = io.readFileSync(verdictPath)
  if (!fresh) {
    return {
      pass: false,
      finding: 'the checker wrote no fresh verdict this round (an older verdict.md was present)',
      raw: raw.slice(0, 2000),
      fresh: false,
      path: verdictPath,
    }
  }
  return { ...parseVerdict(raw), fresh: true, path: verdictPath }
}

/**
 * Run one shell command in the workspace. The command is the ticket's ordered
 * done-when; its output is evidence for the checker, never a substitute for the
 * checker's verdict.
 */
export function runShellCommand(command, { cwd, timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, durationMs: Date.now() - startedAt, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    })
  })
}

/**
 * Run one checker round.
 *
 * @param options.workspace  - the directory that holds the artefact and verdict.md.
 * @param options.command    - the ordered done-when command (optional).
 * @param options.checker    - async ({ workspace, commandResult, startedAt }) =>
 *   any; the callback plays the fresh checker and writes verdict.md. Omit it to
 *   read a verdict that was written by something else.
 * @param options.now        - injectable clock.
 * @param options.io         - injectable file operations.
 * @param options.runner     - injectable command runner.
 */
export async function runVerifyGate({
  workspace,
  command,
  checker,
  now = Date.now,
  io = realIo,
  runner = runShellCommand,
} = {}) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new Error('runVerifyGate needs a workspace directory')
  }
  const verdictPath = join(workspace, 'verdict.md')
  const stale = setAsideStale(verdictPath, 'gate', io)
  const startedAt = now()
  const commandResult = typeof command === 'string' && command.length > 0
    ? await runner(command, { cwd: workspace })
    : null
  let checkerResult
  if (typeof checker === 'function') {
    checkerResult = await checker({ workspace, commandResult, startedAt })
  }
  const verdict = readFreshVerdict({ workspace, startedAt, io })
  return {
    ok: verdict.pass === true,
    verdict,
    commandResult,
    checkerResult,
    startedAt,
    stale: stale ?? null,
  }
}

/** A short, human-readable gate report, used by the example and by tests. */
export function formatGateReport(result) {
  const lines = []
  lines.push(`gate: ${result.ok ? 'PASS' : 'FAIL'}`)
  if (result.stale !== null) lines.push(`stale verdict set aside: ${result.stale}`)
  if (result.commandResult !== null) {
    lines.push(`done-when: exit ${result.commandResult.code} in ${result.commandResult.durationMs}ms`)
    const tail = String(result.commandResult.stdout ?? '').trim().split('\n').slice(-3)
    for (const line of tail) if (line.length > 0) lines.push(`  ${line}`)
  }
  lines.push(`verdict: ${result.verdict.pass ? 'PASS' : 'FAIL'} — ${result.verdict.finding}`)
  return lines.join('\n')
}

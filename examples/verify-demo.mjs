/**
 * A runnable demonstration of the checker gate.
 *
 * Round 1: an artefact exists, the done-when passes, a fresh checker reads the
 *          file and writes PASS. The gate accepts it.
 * Round 2: the artefact is gone. A leftover PASS from round 1 is set aside; the
 *          checker writes FAIL. The gate refuses it.
 *
 * Run with: node examples/verify-demo.mjs
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatGateReport, runVerifyGate } from '../src/gate.js'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-gate-demo-'))
const artefact = join(workspace, 'release.txt')
const doneWhen = 'test -f release.txt && grep -qx "the fleet is up" release.txt'

/** A stand-in for the fresh checker: it reads the artefact and writes a verdict. */
async function freshChecker({ workspace }) {
  let pass = false
  try {
    pass = readFileSync(join(workspace, 'release.txt'), 'utf8').trim() === 'the fleet is up'
  } catch {
    pass = false
  }
  writeFileSync(
    join(workspace, 'verdict.md'),
    pass
      ? 'I ran the done-when myself and read release.txt.\nVERDICT: PASS\n'
      : 'release.txt is missing, so the ordered done-when does not hold.\nVERDICT: FAIL — release.txt is missing\n',
  )
}

try {
  writeFileSync(artefact, 'the fleet is up\n')
  const green = await runVerifyGate({ workspace, command: doneWhen, checker: freshChecker })
  console.log('--- round 1: the artefact is present ---')
  console.log(formatGateReport(green))
  console.log()

  unlinkSync(artefact)
  const red = await runVerifyGate({ workspace, command: doneWhen, checker: freshChecker })
  console.log('--- round 2: the artefact is gone, a stale PASS is on disk ---')
  console.log(formatGateReport(red))
  console.log()

  if (green.ok !== true || red.ok !== false) {
    console.error('demo failed: expected round 1 to pass and round 2 to fail')
    process.exitCode = 1
  } else {
    console.log('demo passed: the gate accepted a fresh PASS and refused a stale one.')
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

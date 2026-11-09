import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKER_VERDICT_MTIME_TOLERANCE_MS,
  formatGateReport,
  parseVerdict,
  readFreshVerdict,
  runVerifyGate,
  setAsideStale,
} from '../src/gate.js'

function workspace() {
  return mkdtempSync(join(tmpdir(), 'dsh-gate-test-'))
}

test('a verdict is read from the verdict line, not the prose', () => {
  assert.equal(parseVerdict('all good\nVERDICT: PASS').pass, true)
  const failed = parseVerdict('VERDICT: FAIL — the file is missing')
  assert.equal(failed.pass, false)
  assert.equal(failed.finding, 'the file is missing')
  assert.equal(parseVerdict('I think it is fine').pass, false)
  assert.equal(parseVerdict('').finding, 'the checker wrote no verdict file')
})

test('the last line-anchored verdict wins over an earlier quoted PASS', () => {
  const text = [
    'The previous round said:',
    'VERDICT: PASS',
    'but the artefact was rebuilt and the order no longer holds.',
    'VERDICT: FAIL — the second artefact is missing',
  ].join('\n')
  const verdict = parseVerdict(text)
  assert.equal(verdict.pass, false)
  assert.equal(verdict.finding, 'the second artefact is missing')
})

test('a stale verdict is set aside so it can never be read as fresh', () => {
  const dir = workspace()
  try {
    const path = join(dir, 'verdict.md')
    writeFileSync(path, 'VERDICT: PASS\n')
    const aside = setAsideStale(path, 'round 2')
    assert.equal(aside, join(dir, 'verdict.md.stale-round-2'))
    assert.equal(readFileSync(aside, 'utf8'), 'VERDICT: PASS\n')
    assert.throws(() => statSync(path))
    assert.equal(setAsideStale(path, 'round 3'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a verdict older than the round is not a pass', () => {
  const dir = workspace()
  try {
    const path = join(dir, 'verdict.md')
    writeFileSync(path, 'VERDICT: PASS\n')
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    const verdict = readFreshVerdict({ workspace: dir, startedAt: Date.now() })
    assert.equal(verdict.pass, false)
    assert.equal(verdict.fresh, false)
    assert.match(verdict.finding, /no fresh verdict/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a verdict inside the mtime tolerance counts as this round', () => {
  const dir = workspace()
  try {
    const path = join(dir, 'verdict.md')
    writeFileSync(path, 'VERDICT: PASS\n')
    const mtime = Date.now() - Math.floor(CHECKER_VERDICT_MTIME_TOLERANCE_MS / 2)
    utimesSync(path, new Date(mtime), new Date(mtime))
    const verdict = readFreshVerdict({ workspace: dir, startedAt: Date.now() })
    assert.equal(verdict.pass, true)
    assert.equal(verdict.fresh, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the gate runs the done-when command and accepts a fresh checker verdict', async () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'artefact.txt'), 'ready\n')
    const result = await runVerifyGate({
      workspace: dir,
      command: 'test -f artefact.txt && grep -qx ready artefact.txt',
      checker: async () => { writeFileSync(join(dir, 'verdict.md'), 'read the file myself\nVERDICT: PASS\n') },
    })
    assert.equal(result.commandResult.ok, true)
    assert.equal(result.verdict.fresh, true)
    assert.equal(result.ok, true)
    assert.match(formatGateReport(result), /^gate: PASS/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a leftover PASS is set aside and a fresh FAIL decides the round', async () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'verdict.md'), 'VERDICT: PASS\n')
    const result = await runVerifyGate({
      workspace: dir,
      checker: async () => { writeFileSync(join(dir, 'verdict.md'), 'the artefact is empty\nVERDICT: FAIL — the artefact is empty\n') },
    })
    assert.equal(result.ok, false)
    assert.notEqual(result.stale, null)
    assert.match(result.verdict.finding, /artefact is empty/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no verdict is a fail, and a failed command does not fabricate one', async () => {
  const dir = workspace()
  try {
    const result = await runVerifyGate({
      workspace: dir,
      command: 'exit 7',
    })
    assert.equal(result.commandResult.code, 7)
    assert.equal(result.ok, false)
    assert.equal(result.verdict.pass, false)
    assert.match(result.verdict.finding, /no verdict file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runVerifyGate refuses a workspace-less call', async () => {
  await assert.rejects(() => runVerifyGate({}), /needs a workspace/)
})

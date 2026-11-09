import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMISSION_CAP,
  ADMISSION_WEIGHTS,
  SETTLED_STATUSES,
  TICKET_RUNNING_STATUSES,
  admissionState,
  classifyTicket,
  decideStart,
  measureGauge,
  resetGaugeProvider,
  runningLoad,
  setGaugeProvider,
} from '../src/admission.js'

const COLD_MACHINE = { loadavg: [1, 1, 1], cores: 8, memAvailable: 24 * 1024 ** 3, memTotal: 32 * 1024 ** 3 }
const HOT_MACHINE = { loadavg: [20, 18, 16], cores: 8, memAvailable: 2 * 1024 ** 3, memTotal: 32 * 1024 ** 3 }

test('the cap is six and it is not a config knob', () => {
  assert.equal(ADMISSION_CAP, 6)
  assert.equal(ADMISSION_WEIGHTS.light, 1)
  assert.equal(ADMISSION_WEIGHTS.build, 2)
  assert.equal(ADMISSION_WEIGHTS.render, 2)
  assert.equal(ADMISSION_WEIGHTS.video, 3)
})

test('classifyTicket reads the headline and weights heavy jobs above one slot', () => {
  assert.equal(classifyTicket({ title: 'Ticket 1 — write the notes' }, {}).weight, 1)
  assert.equal(classifyTicket({ title: 'Ticket 2 — record the walkthrough video' }, {}).weight, 3)
  assert.equal(classifyTicket({ title: 'Ticket 3 — render the frames' }, {}).weight, 2)
  assert.equal(classifyTicket({ title: 'Ticket 4 — production build' }, {}).weight, 2)
  assert.equal(classifyTicket({ title: 'Ticket 5 — record the walkthrough video' }, { title: 'Ticket 5 — light work' }).weight, 3)
})

test('the load gauge needs real CPU and RAM headroom', () => {
  const cold = measureGauge(COLD_MACHINE)
  assert.equal(cold.ok, true)
  assert.equal(cold.cpuOk, true)
  assert.equal(cold.ramOk, true)

  const hot = measureGauge(HOT_MACHINE)
  assert.equal(hot.ok, false)
  assert.equal(hot.cpuOk, false)
  assert.equal(hot.ramOk, false)
  assert.match(hot.reason, /CPU load/)
  assert.match(hot.reason, /RAM available/)
})

test('a gauge can be injected for deterministic proofs, then restored', () => {
  setGaugeProvider(() => measureGauge(COLD_MACHINE))
  try {
    assert.equal(measureGauge(COLD_MACHINE).ok, true)
  } finally {
    resetGaugeProvider()
  }
})

test('runningLoad counts only running ticket swarms and weights heavy ones', () => {
  const missions = [
    { id: 'm-1', title: 'Ticket 1 — light', status: 'running', origin: { kind: 'slack' } },
    { id: 'm-2', title: 'Ticket 2 — record the walkthrough video', status: 'checking', origin: { kind: 'slack' } },
    { id: 'm-3', title: 'Ticket 3 — settled', status: 'done', origin: { kind: 'slack' } },
    { id: 'm-4', title: 'internal mission', status: 'running' },
    { id: 'm-5', title: 'Ticket 5 — parked', status: 'parked', origin: { kind: 'slack' } },
  ]
  const load = runningLoad({ missions })
  assert.equal(load.count, 2)
  assert.equal(load.weighted, 4)
  assert.equal(load.otherRunning, 1)
  assert.deepEqual(load.tickets.map((entry) => entry.missionId), ['m-1', 'm-2'])
  assert.ok(TICKET_RUNNING_STATUSES.has('fixing'))
  assert.ok(SETTLED_STATUSES.has('parked'))
})

test('decideStart refuses a seventh swarm before it looks at load', () => {
  const decision = decideStart({
    state: {
      running: { count: 6, weighted: 6, tickets: [] },
      gauge: measureGauge(COLD_MACHINE),
    },
    weight: 1,
  })
  assert.equal(decision.admitted, false)
  assert.equal(decision.code, 'cap')
})

test('decideStart refuses a start on a hot machine', () => {
  const decision = decideStart({
    state: {
      running: { count: 1, weighted: 1, tickets: [] },
      gauge: measureGauge(HOT_MACHINE),
    },
    weight: 1,
  })
  assert.equal(decision.admitted, false)
  assert.equal(decision.code, 'load')
})

test('decideStart refuses a heavy job whose slots are not free', () => {
  const decision = decideStart({
    state: {
      running: { count: 3, weighted: 5, tickets: [] },
      gauge: measureGauge(COLD_MACHINE),
    },
    weight: 3,
  })
  assert.equal(decision.admitted, false)
  assert.equal(decision.code, 'weight')
  assert.match(decision.reason, /would make 8 of 6 slots/)
})

test('decideStart admits a legal start and never mutates the fleet', () => {
  const missions = [{ id: 'm-1', title: 'Ticket 1 — light', status: 'running', origin: { kind: 'slack' } }]
  const before = structuredClone(missions)
  const load = runningLoad({ missions })
  const decision = decideStart({
    state: { running: load, gauge: measureGauge(COLD_MACHINE) },
    weight: 1,
  })
  assert.equal(decision.admitted, true)
  assert.equal(decision.code, 'admitted')
  assert.deepEqual(missions, before)
})

test('admissionState says open or closed in one readable line', () => {
  const open = admissionState({
    missions: [{ id: 'm-1', title: 'Ticket 1', status: 'running', origin: { kind: 'slack' } }],
    gauge: measureGauge(COLD_MACHINE),
    now: '2026-11-09T00:00:00.000Z',
  })
  assert.equal(open.state, 'open')
  assert.match(open.headline, /^ADMISSION OPEN/)
  assert.equal(open.admissionOnly, true)
  assert.equal(open.generatedAt, '2026-11-09T00:00:00.000Z')

  const closed = admissionState({
    missions: Array.from({ length: 6 }, (_, index) => ({
      id: `m-${index}`,
      title: `Ticket ${index}`,
      status: 'running',
      origin: { kind: 'slack' },
    })),
    gauge: measureGauge(COLD_MACHINE),
  })
  assert.equal(closed.state, 'closed')
  assert.match(closed.headline, /^ADMISSION CLOSED/)
  assert.equal(closed.remaining, 0)
})

test('admissionState keeps at most the last twenty decisions', () => {
  const decisions = Array.from({ length: 25 }, (_, index) => ({ index }))
  const state = admissionState({ missions: [], gauge: measureGauge(COLD_MACHINE), decisions })
  assert.equal(state.decisions.length, 20)
  assert.equal(state.decisions[0].index, 5)
})

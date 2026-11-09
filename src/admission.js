/**
 * Ticket-start admission control — the owner's concurrency ruling, enforced by
 * the harness itself.
 *
 * The ruling (owner, 8 Nov 2026, posted in the fleet channel; ticket 087):
 *
 *   "Max 6 ticket swarms run concurrently on the desktop. This is an ADMISSION
 *    rule: no new ticket starts while 6 are running — running tickets are never
 *    killed mid-flight; the current surge drains to 6 and stays there.
 *    Under the ceiling, admission is load-gauged: a new start needs real CPU/RAM
 *    headroom, and heavy jobs (renders, video, builds) count as more than one
 *    slot of load. If load stays critical at 6, the lead parks lowest-priority
 *    runners at safe checkpoints and reports it in that ticket's thread.
 *    ... The 6-cap is a machine-load rule, not a usage or permission gate."
 *
 * This module is the rule as pure functions: no state, no I/O at import time,
 * and no action beyond the decision itself. It NEVER kills, pauses or parks
 * anything — an admission decision can only postpone a START. Parking at a safe
 * checkpoint stays a deliberate lead/session act (the ruling names the lead,
 * not the gate), so the mechanism here is admission-only by construction.
 *
 * The weights and thresholds are part of the finish pack's stated mechanism:
 *   light 1 · build 2 · render 2 · video 3   (heavy jobs weigh more than one slot)
 *   CPU ceiling 0.90 x core count (1-min loadavg), RAM floor 6 GiB AND 10% free.
 */

import os from 'node:os'
import { readFileSync } from 'node:fs'

/** Mission statuses in which a ticket's swarm is running (counts against the cap). */
export const TICKET_RUNNING_STATUSES = new Set(['running', 'checking', 'resuming', 'fixing'])

/** Mission statuses in which a mission is settled and can never be a queued start. */
export const SETTLED_STATUSES = new Set(['done', 'failed', 'parked', 'rederived', 'blocked'])

/** The owner's hard ceiling: 6 ticket swarms. Deliberately NOT a config knob. */
export const ADMISSION_CAP = 6

/** What one ticket start costs in load slots. Heavy jobs weigh more than one. */
export const ADMISSION_WEIGHTS = Object.freeze({ light: 1, build: 2, render: 2, video: 3 })

/** The machine-load gauge: real CPU and RAM headroom required for a start. */
export const ADMISSION_GAUGE = Object.freeze({
  cpuLoadPerCoreMax: 0.9,
  ramAvailableMinBytes: 6 * 1024 ** 3,
  ramAvailableFractionMin: 0.10,
})

/** The provenance line the panel and the finish carry for the rule. */
export const ADMISSION_SOURCE = 'owner ruling 8 Nov 2026 (fleet channel)'

/**
 * The heavy-job vocabulary, highest weight first. A ticket is heavy when its
 * HEADLINE names one of these jobs; the first (heaviest) match wins and its
 * keyword is recorded as the basis, so the finish can say WHY a ticket was
 * counted as more than one slot.
 *
 * Why the headline and not the whole order: every front-end ticket in this
 * fleet carries the standing Ticket-056 evidence requirement ("walkthrough
 * video … in the VMs") in its order text, so scanning the whole order made
 * EVERY front-end ticket a "video" job (weight 3 of 6) and the ceiling could
 * never run more than two tickets — observed live on 9 Nov 04:00Z, where 17 of
 * 20 tickets classified heavy. The headline says what the job IS; the order's
 * boilerplate says what evidence every job owes. Explicit `heavy: true` on an
 * order still overrides this, and the mission title is checked first.
 */
export const HEAVY_JOB_PATTERNS = Object.freeze([
  { kind: 'video', weight: ADMISSION_WEIGHTS.video, test: /\b(?:walkthrough video|video take|record (?:a |the )?(?:walkthrough|take|video|demo)|screen ?record(?:ing)?|video recording|demo video|vm take|qemu take|ffmpeg)\b/i },
  { kind: 'render', weight: ADMISSION_WEIGHTS.render, test: /\b(?:render (?:set|pass|proof|farm|a video)|render the frames|frame capture|screenshot set|blender|three\.?js)\b/i },
  { kind: 'build', weight: ADMISSION_WEIGHTS.build, test: /\b(?:full build|production build|release build|installer build|build (?:the )?(?:installer|package|release|dist|bundle)|compile the (?:app|tree|suite))\b/i },
])

/** The text one ticket start is classified from: its headline only. */
function ticketText(mission, contract) {
  const parts = []
  if (mission !== null && mission !== undefined && typeof mission.title === 'string') parts.push(mission.title)
  if (contract !== null && contract !== undefined && typeof contract === 'object') {
    if (typeof contract.title === 'string') parts.push(contract.title)
    // The order's own title is the ticket-format headline ("TICKET 087 — …").
    // The goal is NOT scanned: the standing evidence boilerplate lives there in
    // some filings, and the headline is the HONEST signal of the job's load.
  }
  return parts.join('\n')
}

/**
 * Classify one ticket start by the load it costs.
 *
 * @param mission - the fleet's mission record (its title is read).
 * @param contract - the mission's order (its goal/done-when are read).
 * @returns {{ weight:number, kind:string, basis:string, heavy:boolean }}
 */
export function classifyTicket(mission, contract) {
  const text = ticketText(mission, contract)
  for (const pattern of HEAVY_JOB_PATTERNS) {
    const match = pattern.test.exec(text)
    if (match === null) continue
    return {
      weight: pattern.weight,
      kind: pattern.kind,
      heavy: pattern.weight > 1,
      basis: `heavy-job keyword "${match[0].toLowerCase()}" (${pattern.kind} = ${pattern.weight} slot${pattern.weight === 1 ? '' : 's'})`,
    }
  }
  return { weight: ADMISSION_WEIGHTS.light, kind: 'light', heavy: false, basis: 'no heavy-job keyword: light = 1 slot' }
}

/**
 * The gauge provider the host wiring reads.
 *
 * `measureGauge` reads the real machine. A test or a contained-host proof may
 * install a provider (that is how the surge/load tests are made deterministic:
 * a synthetic machine, not whatever load the developer's box happens to carry),
 * and `resetGaugeProvider` restores the real reading. Production code never
 * calls the setter; it exists so the mechanism can be proven without loading
 * the desktop it protects.
 */
let gaugeProvider = (input) => measureGauge(input)
export function currentGauge() { return gaugeProvider() }
export function setGaugeProvider(provider) { gaugeProvider = typeof provider === 'function' ? provider : (input) => measureGauge(input) }
export function resetGaugeProvider() { gaugeProvider = (input) => measureGauge(input) }

/** The available memory in bytes on Linux, falling back to the OS's own value. */
export function memAvailableBytes() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text)
    if (match !== null) return Number(match[1]) * 1024
  } catch { /* fall through to the OS value */ }
  return os.freemem()
}

/**
 * Measure the machine-load gauge.
 *
 * @param input - optional injectable reading for tests/proofs:
 *   { loadavg:[1,5,15], cores, memAvailable, memTotal }.
 * @returns the gauge object the panel and the finish carry (schema in CONTRACT.md).
 */
export function measureGauge(input = {}) {
  const reading = input !== null && typeof input === 'object' ? input : {}
  const loadavg = Array.isArray(reading.loadavg) && reading.loadavg.length >= 1
    ? reading.loadavg.slice(0, 3).map(Number)
    : os.loadavg().slice(0, 3).map(Number)
  const cores = Number.isFinite(Number(reading.cores)) && Number(reading.cores) > 0
    ? Math.trunc(Number(reading.cores))
    : (os.cpus()?.length ?? 1)
  const memTotal = Number.isFinite(Number(reading.memTotal)) && Number(reading.memTotal) > 0
    ? Number(reading.memTotal)
    : os.totalmem()
  const memAvailable = Number.isFinite(Number(reading.memAvailable))
    ? Number(reading.memAvailable)
    : memAvailableBytes()
  const load1 = Number.isFinite(loadavg[0]) ? loadavg[0] : 0
  const cpuLoadPerCore = cores > 0 ? load1 / cores : load1
  const ramAvailableFraction = memTotal > 0 ? memAvailable / memTotal : 0
  const cpuOk = cpuLoadPerCore <= ADMISSION_GAUGE.cpuLoadPerCoreMax
  const ramOk = memAvailable >= ADMISSION_GAUGE.ramAvailableMinBytes
    && ramAvailableFraction >= ADMISSION_GAUGE.ramAvailableFractionMin
  const reasons = []
  if (!cpuOk) {
    reasons.push(`CPU load ${cpuLoadPerCore.toFixed(2)}/core over the ${ADMISSION_GAUGE.cpuLoadPerCoreMax.toFixed(2)}/core ceiling (loadavg ${load1.toFixed(2)} on ${cores} cores)`)
  }
  if (!ramOk) {
    const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1)
    reasons.push(`RAM available ${gib(memAvailable)} GiB of ${gib(memTotal)} GiB under the ${gib(ADMISSION_GAUGE.ramAvailableMinBytes)} GiB floor`)
  }
  return {
    loadavg,
    cores,
    cpuLoadPerCore: Number(cpuLoadPerCore.toFixed(4)),
    cpuOk,
    memAvailableBytes: memAvailable,
    memTotalBytes: memTotal,
    ramAvailableFraction: Number(ramAvailableFraction.toFixed(4)),
    ramOk,
    ok: cpuOk && ramOk,
    reason: reasons.length > 0 ? reasons.join('; ') : `headroom available: CPU ${cpuLoadPerCore.toFixed(2)}/core, RAM ${(memAvailable / 1024 ** 3).toFixed(1)} GiB free`,
  }
}

/**
 * The running ticket-swarm load right now: how many ticket swarms are running
 * and what they weigh.
 *
 * @param missions - every mission record (an array or an id->record object).
 * @param contractOf - (missionId) => the mission's order contract (optional).
 */
export function runningLoad({ missions, contractOf } = {}) {
  const list = Array.isArray(missions)
    ? missions
    : Object.values(missions !== null && typeof missions === 'object' ? missions : {})
  const tickets = []
  let otherRunning = 0
  for (const mission of list) {
    if (mission === null || mission === undefined) continue
    if (!TICKET_RUNNING_STATUSES.has(mission.status)) continue
    if (mission.origin?.kind !== 'slack') { otherRunning += 1; continue }
    const contract = typeof contractOf === 'function' ? contractOf(mission.id) : undefined
    const classified = classifyTicket(mission, contract)
    tickets.push({
      missionId: mission.id,
      title: mission.title ?? mission.id,
      status: mission.status,
      weight: classified.weight,
      kind: classified.kind,
      basis: classified.basis,
      laneId: mission.laneId ?? null,
    })
  }
  tickets.sort((left, right) => left.missionId.localeCompare(right.missionId))
  const weighted = tickets.reduce((sum, entry) => sum + entry.weight, 0)
  return { count: tickets.length, weighted, tickets, otherRunning }
}

/**
 * One admission decision for one ticket start.
 *
 * Order is deliberate and fixed:
 *   1. the 6-slot ceiling on the COUNT of running ticket swarms (the 7th start
 *      is queued even when every job is light);
 *   2. the machine-load gauge (a start needs real CPU/RAM headroom);
 *   3. heavy-job weighting (a heavy start needs its slots free in the same 6).
 *
 * @returns {{ admitted:boolean, code:'admitted'|'cap'|'load'|'weight', reason:string, running:object }}
 */
export function decideStart({ state, weight = ADMISSION_WEIGHTS.light } = {}) {
  const cap = Number.isInteger(state?.cap) ? state.cap : ADMISSION_CAP
  const running = state?.running ?? { count: 0, weighted: 0, tickets: [] }
  const gauge = state?.gauge ?? measureGauge()
  if (running.count >= cap) {
    return {
      admitted: false,
      code: 'cap',
      reason: `${running.count} of ${cap} ticket swarms running — the ${running.count + 1}th ticket start is queued`,
      running,
    }
  }
  if (gauge.ok !== true) {
    return {
      admitted: false,
      code: 'load',
      reason: `load gauge holds the start: ${gauge.reason}`,
      running,
    }
  }
  const projected = running.weighted + Number(weight)
  if (projected > cap) {
    return {
      admitted: false,
      code: 'weight',
      reason: `heavy-job weight ${weight} would make ${projected} of ${cap} slots (${running.weighted} weighted slots already running)`,
      running,
    }
  }
  return {
    admitted: true,
    code: 'admitted',
    reason: `${running.count}/${cap} swarms, ${running.weighted}/${cap} weighted slots running, gauge ok — admitted at weight ${weight}`,
    running,
  }
}

/** Round one number for the panel. */
function round(value, digits) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

/**
 * The full admission model the fleet panel and the finish read.
 *
 * @param options.missions - every mission record.
 * @param options.contractOf - (missionId) => order contract, for weighting.
 * @param options.gauge - a measured gauge (defaults to a real reading).
 * @param options.cap - the ceiling (defaults to the owner's 6).
 * @param options.queue - ticket starts queued by the bridge:
 *   [{ ticket, missionId, title, weight, kind, reason, code, since }].
 * @param options.decisions - the bridge's bounded decision history.
 */
export function admissionState({ missions, contractOf, gauge, cap = ADMISSION_CAP, queue = [], decisions = [], now } = {}) {
  const measured = gauge ?? measureGauge()
  const running = runningLoad({ missions, contractOf })
  const effectiveCap = Number.isInteger(cap) && cap > 0 ? cap : ADMISSION_CAP
  const lightDecision = decideStart({ state: { cap: effectiveCap, running, gauge: measured }, weight: ADMISSION_WEIGHTS.light })
  const open = lightDecision.admitted === true && running.weighted + ADMISSION_WEIGHTS.light <= effectiveCap
  const remaining = Math.max(0, effectiveCap - running.count)
  const slotsRemaining = Math.max(0, effectiveCap - running.weighted)
  let headline
  if (open) {
    headline = `ADMISSION OPEN — ${running.count} of ${effectiveCap} ticket swarms running, ${remaining} swarm slot${remaining === 1 ? '' : 's'} and headroom available`
  } else if (lightDecision.code === 'cap') {
    headline = `ADMISSION CLOSED — ${running.count} of ${effectiveCap} ticket swarms running; new ticket starts are queued`
  } else if (lightDecision.code === 'load') {
    headline = `ADMISSION CLOSED — load gauge holds new ticket starts: ${measured.reason}`
  } else {
    headline = `ADMISSION CLOSED — heavy-job slots full: ${running.weighted} of ${effectiveCap} weighted slots running (${running.count} swarms); new starts are queued`
  }
  return {
    rule: {
      cap: effectiveCap,
      weights: { ...ADMISSION_WEIGHTS },
      gauge: { ...ADMISSION_GAUGE },
      source: ADMISSION_SOURCE,
    },
    gauge: measured,
    running: {
      count: running.count,
      weighted: running.weighted,
      tickets: running.tickets,
      otherRunning: running.otherRunning,
    },
    cap: effectiveCap,
    weightedCap: effectiveCap,
    remaining,
    slotsRemaining,
    state: open ? 'open' : 'closed',
    headline,
    reason: lightDecision.reason,
    queue: Array.isArray(queue) ? queue : [],
    decisions: Array.isArray(decisions) ? decisions.slice(-20) : [],
    admissionOnly: true,
    note: 'Admission never kills, pauses or parks a running ticket; a start waits for a slot and for real CPU/RAM headroom. Parking at a safe checkpoint stays a deliberate lead act (owner ruling).',
    generatedAt: now ?? new Date().toISOString(),
  }
}

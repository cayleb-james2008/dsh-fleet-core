/**
 * dsh-fleet-core — three mechanisms from a working six-seat agent fleet.
 *
 *   admission  — the owner's concurrency ruling as a pure decision function
 *   router     — provider rotation with pins, fallbacks and a hard ban list
 *   gate       — a checker gate that cannot accept a stale or self-written verdict
 *
 * Each module is standalone and dependency-free. See README.md.
 */

export * from './admission.js'
export * from './router.js'
export * from './gate.js'

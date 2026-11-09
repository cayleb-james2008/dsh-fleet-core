import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BANNED_MODELS,
  createMemoryStore,
  createRouter,
  describeError,
  isCredentialRejected,
  isUsageExhausted,
} from '../src/router.js'

function makeRouter(initial = {}) {
  const store = createMemoryStore(initial)
  const router = createRouter({ store })
  return { store, router }
}

test('the two picks are seeded from the app default when nothing is chosen', () => {
  const { router } = makeRouter()
  assert.equal(DEFAULT_BANNED_MODELS.length, 1)
  assert.match(DEFAULT_BANNED_MODELS[0], /fable/)
  assert.deepEqual(router.modelSelectors(), { main: undefined, subAgent: undefined })
  const seededRouter = createRouter({
    store: createMemoryStore(),
    defaultSelection: () => ({ provider: 'acme', model: 'model-a', reasoningEffort: 'high' }),
  })
  assert.deepEqual(seededRouter.modelSelectors(), {
    main: { provider: 'acme', model: 'model-a', reasoningEffort: 'high' },
    subAgent: { provider: 'acme', model: 'model-a', reasoningEffort: 'high' },
  })
})

test('a banned model can never become a pick, whatever the catalogue calls it', () => {
  const { store, router } = makeRouter()
  assert.throws(
    () => router.setModelSelectors({ main: { provider: 'openrouter', model: 'claude-3-fable' } }),
    /may not be a banned model/,
  )
  assert.throws(
    () => router.setRotation([{ provider: 'openrouter', model: 'claude-sonnet-4-fable' }]),
    /may not carry a banned model/,
  )
  assert.equal(router.isBanned({ provider: 'x', model: 'claude-fable-5' }), true)
  assert.equal(store.state().modelSelectors.main, undefined)
})

test('a route with an allow-list serves only the models it names', () => {
  const { router } = makeRouter()
  assert.equal(router.isBanned({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), false)
  assert.equal(router.isBanned({ provider: 'opencode-go', model: 'some-other-model' }), true)
  assert.equal(router.isBanned({ provider: 'openrouter', model: 'some-other-model' }), false)
  assert.deepEqual(router.routeAllowedModels(), { 'opencode-go': ['deepseek-v4.1-flash'] })
})

test('the chain starts at the pick and falls back along the rotation without repeating it', () => {
  const { router } = makeRouter()
  router.setModelSelectors({
    main: { provider: 'acme', model: 'a', reasoningEffort: 'high' },
    subAgent: { provider: 'acme', model: 'a', reasoningEffort: 'high' },
  })
  router.setRotation([
    { provider: 'acme', model: 'a', tier: 'worker' },
    { provider: 'beta', model: 'b', reasoningEffort: 'low' },
    { provider: 'gamma', model: 'c' },
  ])
  const chain = router.chainFor('main')
  assert.deepEqual(chain.map((entry) => `${entry.provider}:${entry.model}`), ['acme:a', 'beta:b', 'gamma:c'])
})

test('a spent pick is left out of its own chain', () => {
  const { router } = makeRouter()
  router.setModelSelectors({ main: { provider: 'acme', model: 'a' } })
  router.setRotation([
    { provider: 'acme', model: 'a', spent: true },
    { provider: 'beta', model: 'b' },
  ])
  assert.deepEqual(router.chainFor('main').map((entry) => `${entry.provider}:${entry.model}`), ['beta:b'])
})

test('routeFor pins a model and records whether it fell back', () => {
  const { store, router } = makeRouter()
  router.setModelSelectors({ main: { provider: 'acme', model: 'a' } })
  router.setRotation([
    { provider: 'acme', model: 'a' },
    { provider: 'beta', model: 'b' },
  ])
  const first = router.routeFor('main')
  assert.equal(first.pinned, true)
  assert.equal(first.selector, 'main')
  assert.equal(first.fellBack, false)
  assert.equal(first.provider, 'acme')

  const next = router.routeFor('main', { index: 1 })
  assert.equal(next.provider, 'beta')
  assert.equal(next.fellBack, true)

  const audit = store.audit()
  assert.equal(audit.filter((entry) => entry.event === 'routing').length, 2)
  assert.equal(audit[1].fellBack, true)
})

test('a failed route moves to the next candidate, skipping rejected keys', () => {
  const { router } = makeRouter()
  router.setModelSelectors({ subAgent: { provider: 'acme', model: 'a' } })
  router.setRotation([
    { provider: 'acme', model: 'a' },
    { provider: 'beta', model: 'b' },
    { provider: 'gamma', model: 'c' },
  ])
  const after = { provider: 'acme', model: 'a' }
  const next = router.nextRouteFor('subAgent', after, ['beta:b'])
  assert.equal(next.provider, 'gamma')
})

test('a spent pick with no other rotation model is a plain refusal, not a crash', () => {
  const { router } = makeRouter()
  router.setModelSelectors({ main: { provider: 'acme', model: 'a' } })
  router.setRotation([{ provider: 'acme', model: 'a', spent: true }])
  assert.throws(() => router.routeFor('main'), /no main model is available/)
})

test('a rejected credential is recorded once and skipped afterwards', () => {
  const { store, router } = makeRouter()
  router.setModelSelectors({ main: { provider: 'acme', model: 'a' } })
  router.setRotation([
    { provider: 'acme', model: 'a' },
    { provider: 'beta', model: 'b' },
  ])
  const route = router.routeFor('main')
  const result = router.recordFailure(route, new Error('401 Unauthorized: invalid api key'))
  assert.deepEqual(result, { reported: true, rejected: true, exhausted: false })
  assert.deepEqual(router.rejectedRoutes(), ['acme:a'])
  assert.equal(store.state().usage['acme:a'].failures, 1)
  assert.equal(store.state().usage['acme:a'].rejected, true)

  const again = router.recordFailure(route, new Error('401 Unauthorized'))
  assert.equal(again.reported, false)
  assert.equal(store.state().usage['acme:a'].failures, 2)
})

test('a usage limit is recorded as exhausted; an ordinary error is not a route failure', () => {
  const { router } = makeRouter()
  const route = { provider: 'acme', model: 'a' }
  const exhausted = router.recordFailure(route, new Error('429 too many concurrent requests'))
  assert.equal(exhausted.exhausted, true)
  assert.equal(router.recordFailure(route, new Error('socket hang up')).reported, false)
  assert.equal(isUsageExhausted('quota exceeded'), true)
  assert.equal(isCredentialRejected('403 forbidden'), true)
  assert.equal(describeError({ message: 'boom' }), 'boom')
})

test('setRotation cleans entries and refuses an empty list', () => {
  const { router } = makeRouter()
  const cleaned = router.setRotation([
    { provider: 'acme', model: 'a', extra: 'dropped', tier: 'worker' },
    null,
    { provider: 42, model: 'x' },
  ])
  assert.deepEqual(cleaned, [{ provider: 'acme', model: 'a', tier: 'worker' }])
  assert.throws(() => router.setRotation([]), /at least one model/)
})

test('the list-based route follows the tier and never runs a banned model', () => {
  const { router } = makeRouter()
  router.setRotation([
    { provider: 'acme', model: 'a', tier: 'worker' },
    { provider: 'beta', model: 'b', tier: 'lead' },
  ])
  assert.equal(router.route(0, [], 'lead').provider, 'beta')
  const banned = createRouter({
    store: createMemoryStore({
      rotation: [
        { provider: 'acme', model: 'a', tier: 'worker' },
        { provider: 'openrouter', model: 'claude-3-fable', tier: 'worker' },
      ],
    }),
  })
  assert.equal(banned.route(0, [], 'worker').provider, 'acme')
})

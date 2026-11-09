/**
 * Provider rotation — the model routing table for a fleet of agents.
 *
 * The owner names two models: `main` for the agent that takes a ticket and
 * leads the work, and `subAgent` for the agents a lead delegates to. A rotation
 * list supplies the fallback chain. Every spawn pins one provider + model; when
 * a pool is spent or a provider rejects its key, the spawn moves along the
 * chain and records that it did. Nothing is ever silently substituted.
 *
 * This is a pure module: the caller supplies a small store (see
 * `createMemoryStore`) and, optionally, a pool tracker. It has no dependency on
 * the harness, the network, or a specific provider.
 */

/** The two model picks the owner makes. */
export const SELECTOR_KINDS = ['main', 'subAgent']

/**
 * The models the fleet is never allowed to run on. The ban is matched by exact
 * id and by shape, so a new catalogue id cannot slip past it.
 */
export const DEFAULT_BANNED_MODELS = ['~anthropic/claude-fable-latest']
const BANNED_MODEL_SHAPES = [/fable/i]

/**
 * Routes with a hard allow-list. A route that is not listed here serves any
 * model; a listed route serves only the models it names.
 */
const ROUTE_ALLOWED_MODELS = {
  'opencode-go': ['deepseek-v4.1-flash'],
}

/** A small in-memory store with the same surface the fleet's store exposes. */
export function createMemoryStore(initial = {}) {
  const state = {
    rotation: [],
    modelSelectors: {},
    bannedModels: [],
    usage: {},
    ...initial,
  }
  const audit = []
  return {
    state: () => state,
    update: (mutator) => { mutator(state); return state },
    appendAudit: (entry) => { audit.push({ ...entry, at: new Date().toISOString() }); return entry },
    audit: () => audit.slice(),
  }
}

/** True when a failure looks like a provider that has run out of usage. */
export function isUsageExhausted(error) {
  const text = describeError(error).toLowerCase()
  return text.includes('429')
    || text.includes('usage limit')
    || text.includes('quota')
    || text.includes('rate limit')
    || text.includes('insufficient quota')
    || text.includes('exceeded your current quota')
    || text.includes('out of credits')
    || text.includes('resource_exhausted')
}

/** True when a failure looks like the provider rejecting the stored credential. */
export function isCredentialRejected(error) {
  const text = describeError(error).toLowerCase()
  return text.includes('401')
    || text.includes('403')
    || text.includes('unauthorized')
    || text.includes('invalid api key')
    || text.includes('invalid_api_key')
    || text.includes('authentication_error')
    || text.includes('permission denied')
}

/** A short, single-line description of any thrown value. */
export function describeError(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Build a router bound to one store.
 *
 * @param options.store         - `{ state(), update(fn), appendAudit(entry) }`.
 * @param options.pools         - optional pool tracker; see `poolFor` / `poolLive`.
 * @param options.defaultSelection - optional function returning the app's own
 *   current `{ provider, model, reasoningEffort }`, used only to seed an empty
 *   rotation. A banned model is never seeded.
 */
export function createRouter({ store, pools, defaultSelection } = {}) {
  if (store === undefined) throw new Error('createRouter needs a store')

  function rotation() {
    const current = store.state().rotation ?? []
    if (current.length > 0) return current
    const seeded = seedFromDefault()
    if (seeded === undefined) return []
    store.update((value) => { value.rotation = [seeded] })
    return [seeded]
  }

  function seedFromDefault() {
    if (typeof defaultSelection !== 'function') return undefined
    try {
      const selection = defaultSelection()
      if (selection === undefined || selection === null) return undefined
      if (selection.provider === undefined || selection.model === undefined) return undefined
      const seeded = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }
      if (isBanned(seeded)) return undefined
      return seeded
    } catch {
      return undefined
    }
  }

  function bannedModels() {
    const saved = store.state().bannedModels
    const extra = Array.isArray(saved) ? saved.filter((entry) => typeof entry === 'string') : []
    return [...new Set([...DEFAULT_BANNED_MODELS, ...extra])]
  }

  /** True when one entry names a model the fleet may not run on. */
  function isBanned(entry) {
    if (entry === undefined || entry === null) return false
    const model = String(entry.model ?? '')
    if (model.length === 0) return false
    if (BANNED_MODEL_SHAPES.some((shape) => shape.test(model))) return true
    if (bannedModels().some((banned) => banned === model || banned === `${entry.provider}:${model}`)) return true
    const allowed = ROUTE_ALLOWED_MODELS[String(entry.provider ?? '')]
    if (allowed !== undefined && !allowed.includes(model)) return true
    return false
  }

  /** True when the owner rule itself bans the model, independent of route allow-lists. */
  function isBannedModel(entry) {
    if (entry === undefined || entry === null) return false
    const model = String(entry.model ?? '')
    if (model.length === 0) return false
    if (BANNED_MODEL_SHAPES.some((shape) => shape.test(model))) return true
    return bannedModels().some((banned) => banned === model || banned === `${entry.provider}:${model}`)
  }

  function routeAllowedModels() {
    return Object.fromEntries(Object.entries(ROUTE_ALLOWED_MODELS).map(([route, models]) => [route, [...models]]))
  }

  function modelSelectors() {
    const saved = store.state().modelSelectors ?? {}
    const pick = (kind) => {
      const entry = saved[kind]
      if (entry !== undefined && entry !== null && typeof entry.provider === 'string' && typeof entry.model === 'string') {
        if (!isBanned(entry)) {
          return {
            provider: entry.provider,
            model: entry.model,
            ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
          }
        }
      }
      const seeded = seedFromDefault() ?? rotation().find((candidate) => !isBanned(candidate))
      if (seeded === undefined) return undefined
      return {
        provider: seeded.provider,
        model: seeded.model,
        ...(seeded.reasoningEffort === undefined ? {} : { reasoningEffort: seeded.reasoningEffort }),
      }
    }
    return { main: pick('main'), subAgent: pick('subAgent') }
  }

  function setModelSelectors(next) {
    const cleaned = {}
    for (const kind of SELECTOR_KINDS) {
      const entry = next?.[kind]
      if (entry === undefined || entry === null) continue
      if (typeof entry !== 'object' || typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
        throw new Error(`the ${kind} model needs a provider and a model`)
      }
      if (isBanned(entry)) {
        throw new Error(`the ${kind} model may not be a banned model: ${entry.provider}:${entry.model}`)
      }
      cleaned[kind] = {
        provider: entry.provider,
        model: entry.model,
        ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
      }
    }
    store.update((value) => { value.modelSelectors = { ...(value.modelSelectors ?? {}), ...cleaned } })
    return modelSelectors()
  }

  /**
   * The chain one kind of spawn falls back along: the owner's pick for that
   * kind, then the rotation. A spent pool and a banned model are routed around.
   */
  function chainFor(kind) {
    const selectors = modelSelectors()
    const head = selectors[kind]
    if (head === undefined) {
      throw new Error(`no ${kind} model is chosen: the owner has not picked one, and no unbanned model is available to fall back to`)
    }
    const headKey = `${head.provider}:${head.model}`
    const spent = rotation().some((entry) => entry.spent === true && `${entry.provider}:${entry.model}` === headKey)
    return [
      ...(spent === true ? [] : [head]),
      ...rotation().filter((entry) => entry.spent !== true
        && !isBanned(entry)
        && `${entry.provider}:${entry.model}` !== headKey),
    ]
  }

  /**
   * The route for one spawn of one kind.
   *
   * @param kind - `main` or `subAgent`.
   * @param options.index - which candidate to take.
   * @param options.skip - `provider:model` keys to skip (rejected keys).
   * @param options.after - the route that just failed; the next candidate is taken.
   */
  function routeFor(kind, { index = 0, skip = [], after } = {}) {
    const chain = chainFor(kind)
    const poolState = pools === undefined ? [] : pools.stateSync()
    const notSkipped = chain.filter((entry) => !skip.includes(`${entry.provider}:${entry.model}`))
    const live = notSkipped.filter((entry) => pools === undefined || pools.poolLive(pools.poolFor(entry, poolState)))
    const candidates = live.length > 0 ? live : notSkipped.length > 0 ? notSkipped : chain
    if (candidates.length === 0) {
      throw new Error(`no ${kind} model is available: the pick is spent and the rotation holds no other model`)
    }
    let picked
    if (after !== undefined) {
      const position = candidates.findIndex((entry) => `${entry.provider}:${entry.model}` === `${after.provider}:${after.model}`)
      picked = candidates[(position + 1 + candidates.length) % candidates.length]
    } else {
      picked = candidates[index % candidates.length]
    }
    const pick = modelSelectors()[kind]
    const route = {
      provider: picked.provider,
      model: picked.model,
      ...(picked.reasoningEffort === undefined ? {} : { reasoningEffort: picked.reasoningEffort }),
      pinned: true,
      tier: kind,
      selector: kind,
      fellBack: pick === undefined || `${picked.provider}:${picked.model}` !== `${pick.provider}:${pick.model}`,
    }
    store.appendAudit?.({
      event: 'routing',
      route: `${route.provider}:${route.model}`,
      tier: kind,
      selector: kind,
      fellBack: route.fellBack === true,
      pools: poolState.map((entry) => ({
        provider: entry.provider,
        remaining: entry.remaining ?? null,
        used: entry.used ?? null,
        limit: entry.limit ?? null,
        measuredTokens: entry.measuredTokens ?? 0,
      })),
    })
    return route
  }

  function nextRouteFor(kind, after, skip = []) {
    return routeFor(kind, { after, skip })
  }

  /** Replace the owner's rotation list. A banned model is refused. */
  function setRotation(entries) {
    const list = Array.isArray(entries) ? entries : []
    const banned = list
      .filter((entry) => entry !== null && typeof entry === 'object')
      .filter((entry) => typeof entry.provider === 'string' && typeof entry.model === 'string')
      .filter((entry) => isBanned(entry))
    if (banned.length > 0) {
      throw new Error(`the rotation may not carry a banned model: ${banned.map((entry) => `${entry.provider}:${entry.model}`).join(', ')}`)
    }
    const cleaned = list
      .filter((entry) => entry !== null && typeof entry === 'object')
      .filter((entry) => typeof entry.provider === 'string' && typeof entry.model === 'string')
      .map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
        ...(entry.tier === undefined ? {} : { tier: entry.tier }),
        ...(entry.spent === undefined ? {} : { spent: entry.spent }),
      }))
    if (cleaned.length === 0) throw new Error('the rotation list needs at least one model')
    store.update((value) => { value.rotation = cleaned })
    return cleaned
  }

  /**
   * The list-based route, used when a spawn does not belong to a selector kind.
   * Kept for schedulers whose tiers (worker, lead, checker) are not the two
   * owner picks.
   */
  function route(index = 0, skip = [], tier = 'worker') {
    const list = rotation()
    if (list.length === 0) throw new Error('no model route is available: the rotation list is empty')
    const poolState = pools === undefined ? [] : pools.stateSync()
    const notSkipped = list
      .filter((entry) => !skip.includes(`${entry.provider}:${entry.model}`))
      .filter((entry) => entry.spent !== true)
      .filter((entry) => !isBanned(entry))
    const live = notSkipped.filter((entry) => pools === undefined || pools.poolLive(pools.poolFor(entry, poolState)))
    const safeList = list.filter((entry) => !isBanned(entry))
    const candidates = live.length > 0 ? live : notSkipped.length > 0 ? notSkipped : safeList
    if (candidates.length === 0) throw new Error('no model route is available: every model in the rotation is banned')
    const inTier = candidates.filter((entry) => (entry.tier ?? 'worker') === tier)
    const pool = inTier.length > 0 ? inTier : candidates
    const ranked = [...pool].sort((left, right) => {
      if (pools === undefined) return 0
      return pools.workerRank(left.model) - pools.workerRank(right.model)
    })
    const picked = ranked[index % ranked.length]
    const chosen = {
      provider: picked.provider,
      model: picked.model,
      ...(picked.reasoningEffort === undefined ? {} : { reasoningEffort: picked.reasoningEffort }),
      pinned: true,
      tier: picked.tier ?? 'worker',
    }
    store.appendAudit?.({
      event: 'routing',
      route: `${chosen.provider}:${chosen.model}`,
      tier,
      pools: poolState.map((entry) => ({
        provider: entry.provider,
        remaining: entry.remaining ?? null,
        used: entry.used ?? null,
        limit: entry.limit ?? null,
        measuredTokens: entry.measuredTokens ?? 0,
      })),
    })
    return chosen
  }

  function nextRoute(after, skip = []) {
    const list = rotation()
    const position = list.findIndex((entry) => `${entry.provider}:${entry.model}` === `${after.provider}:${after.model}`)
    return route(position + 1, skip)
  }

  /** Record a failed route. A rejected key is reported once. */
  function recordFailure(failedRoute, error) {
    const key = `${failedRoute.provider}:${failedRoute.model}`
    const rejected = isCredentialRejected(error)
    const exhausted = isUsageExhausted(error)
    if (!rejected && !exhausted) return { reported: false, rejected: false, exhausted: false }
    let reported = false
    store.update((value) => {
      const usage = { ...(value.usage ?? {}) }
      const entry = {
        ...(usage[key] ?? { failures: 0 }),
        failures: (usage[key]?.failures ?? 0) + 1,
        lastReason: describeError(error).slice(0, 300),
      }
      if (rejected) entry.rejected = true
      if (exhausted) entry.exhausted = true
      if (!entry.reported) {
        entry.reported = true
        reported = true
      }
      usage[key] = entry
      value.usage = usage
    })
    return { reported, rejected, exhausted }
  }

  function rejectedRoutes() {
    const usage = store.state().usage ?? {}
    return Object.entries(usage).filter(([, entry]) => entry.rejected === true).map(([key]) => key)
  }

  return {
    rotation,
    setRotation,
    route,
    nextRoute,
    recordFailure,
    rejectedRoutes,
    modelSelectors,
    setModelSelectors,
    routeFor,
    nextRouteFor,
    chainFor,
    routeAllowedModels,
    bannedModels,
    isBanned,
    isBannedModel,
    isUsageExhausted,
    isCredentialRejected,
    describeError,
  }
}

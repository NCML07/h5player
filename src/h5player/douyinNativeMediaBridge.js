/**
 * Compatibility bridge for Douyin's React/WebCodecs MediaStream player.
 *
 * Douyin keeps the effective playback state on `player._core` when the
 * visible video is backed by a MediaStream. Decimal rate changes cross a
 * float32/WASM boundary, so the core must receive `Math.fround(rate)` or its
 * internal AsyncQueue can remain pending forever. The clean decimal value is
 * retained by h5player for UI and persistence.
 *
 * The bridge is deliberately isolated to non-live douyin.com pages. It also
 * keeps native media getters truthful, selects the active virtualized feed
 * video, seeks through the React player API, lazily guards confirmed page-side
 * 1x reconciliation for rates above 3x, and primes newly-created MediaStream
 * cores before PLAY so remembered rates take effect without a 1x startup gap.
 */

export function isDouyinWebPage (win = window) {
  const host = String((win.location && win.location.hostname) || '').toLowerCase()
  return (host === 'douyin.com' || host.endsWith('.douyin.com')) && host !== 'live.douyin.com'
}

export function createDouyinNativeMediaBridge ({ configManager, i18n, isEditableTarget }) {
  const disabledApi = {
    enabled: false,
    init () {},
    getActiveVideo () { return null },
    getNativePlaybackRate () { return NaN },
    getNativeCurrentTime () { return NaN },
    getPlaybackRate () { return NaN },
    getCurrentTime () { return NaN },
    setDesiredRate () { return false },
    resetDesiredRate () { return false },
    seekBy () { return false },
    snapshot () { return { enabled: false } }
  }

  if (!isDouyinWebPage()) return disabledApi

  const pageWin = window.unsafeWindow || window
  const PageHTMLMediaElement = pageWin.HTMLMediaElement || window.HTMLMediaElement
  const mediaProto = PageHTMLMediaElement && PageHTMLMediaElement.prototype
  if (!mediaProto) return disabledApi

  const getDescriptor = function (name) {
    try {
      return Object.getOwnPropertyDescriptor(mediaProto, name)
    } catch (e) {
      return null
    }
  }

  /* Capture page-realm native accessors before mediaCore installs hooks. */
  const nativeDescriptor = {
    playbackRate: getDescriptor('playbackRate'),
    defaultPlaybackRate: getDescriptor('defaultPlaybackRate'),
    currentTime: getDescriptor('currentTime')
  }

  if (!nativeDescriptor.playbackRate || !nativeDescriptor.playbackRate.get || !nativeDescriptor.playbackRate.set ||
      !nativeDescriptor.currentTime || !nativeDescriptor.currentTime.get || !nativeDescriptor.currentTime.set) {
    return disabledApi
  }

  const rawSetTimeout = window.setTimeout.bind(window)
  const rawSetInterval = window.setInterval.bind(window)
  const rawClearTimeout = window.clearTimeout.bind(window)

  let h5 = null
  let runtimeInited = false
  let applyingDepth = 0
  let desiredRate = null
  let rateGuardActive = false
  let seekGuardVideo = null
  let seekGuardTarget = 0
  let seekGuardAt = 0
  let seekGuardUntil = 0

  /*
   * React to the actual media event target during feed activation, then retry
   * only for a short bounded window while Douyin associates the video with its
   * MediaStream Core. This replaces the always-on subtree observer and 400 ms
   * polling used by the previous bridge.
   */
  let activationGeneration = 0
  let activationTimers = []
  let lastActivationVideo = null
  let lastActivationReason = ''
  let lastActivationAt = 0
  let activationAttemptCount = 0
  let mediaStreamActivationApplyCount = 0
  let legacyActivationApplyCount = 0
  let blockedLegacyRateResetCount = 0
  const activationRetryDelays = [12, 30, 60, 100, 160, 240, 340, 480]

  /*
   * The core accessor guard is installed lazily only when h5player explicitly
   * requests a rate above 3x. Normal 1x-3x operation leaves the core untouched.
   */
  const guardedMediaStreamCores = new window.WeakMap()
  let currentGuardedCore = null
  let blockedSuperRateResetCount = 0

  /*
   * Rapid C/X presses are coalesced into the newest desired value. Repeated
   * retries do not repair Douyin's queue; float32-safe application does.
   */
  let rateApplyTimer = null
  let rateRequestGeneration = 0
  let lastRateHotkeyAt = 0
  const rateHotkeyDebounceMs = 160
  const bridgeVersion = 'douyin-mediastream-preplay-numeric-v10.1'

  /*
   * The MediaStream Core is primed immediately before Douyin posts PLAY to its
   * Worker. This removes the short 1x startup period on newly-created items.
   * Keep a bounded diagnostics log for field verification.
   */
  const prePlayHookedOwners = new Map()
  const prePlayPrimeLog = []
  let prePlayScanTimer = null
  let prePlayHookInstallCount = 0
  let prePlayPrimeAttemptCount = 0
  let prePlayPrimeSuccessCount = 0
  let prePlayLiveSkipCount = 0
  let prePlayLastRecord = null
  let prePlayLastScanSignature = ''

  const activeSelectors = [
    '[data-e2e="feed-active-video"] video',
    '#sliderVideo video',
    '.slider-video video',
    '.douyin-player-video-container video',
    '.xg-video-container video'
  ]

  function isVideoLike (value) {
    try {
      return Boolean(value && String(value.tagName || value.localName || '').toLowerCase() === 'video')
    } catch (e) {
      return false
    }
  }

  function isMediaStreamLikeVideo (video) {
    if (!isVideoLike(video)) return false
    try {
      const srcObject = video.srcObject
      return Boolean(srcObject && String((srcObject.constructor && srcObject.constructor.name) || '') === 'MediaStream')
    } catch (e) {
      return false
    }
  }

  function nativeGet (name, media) {
    const descriptor = nativeDescriptor[name]
    try {
      return descriptor && descriptor.get ? descriptor.get.call(media) : undefined
    } catch (e) {
      return undefined
    }
  }

  function nativeSet (name, media, value) {
    const descriptor = nativeDescriptor[name]
    if (!descriptor || !descriptor.set || !media) return false
    applyingDepth += 1
    try {
      descriptor.set.call(media, value)
      return true
    } catch (e) {
      return false
    } finally {
      applyingDepth -= 1
    }
  }

  function visibleScore (video, priority) {
    if (!video || !video.isConnected || !video.getBoundingClientRect) return -Infinity

    let rect
    try {
      rect = video.getBoundingClientRect()
    } catch (e) {
      return -Infinity
    }

    if (!rect || rect.width < 20 || rect.height < 20) return -Infinity

    try {
      const style = pageWin.getComputedStyle ? pageWin.getComputedStyle(video) : window.getComputedStyle(video)
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
        return -Infinity
      }
    } catch (e) {}

    const vw = pageWin.innerWidth || window.innerWidth || 1
    const vh = pageWin.innerHeight || window.innerHeight || 1
    const visibleWidth = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0))
    const visibleHeight = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0))
    const visibleArea = visibleWidth * visibleHeight
    if (visibleArea <= 0) return -Infinity

    const ownArea = Math.max(1, rect.width * rect.height)
    const visibleRatio = Math.min(1, visibleArea / ownArea)
    const centerY = (rect.top + rect.bottom) / 2
    const centerDistance = Math.abs(centerY - vh / 2) / Math.max(1, vh)

    let score = Number(priority || 0) + visibleRatio * 1500 + Math.min(ownArea, vw * vh) / Math.max(1, vw * vh) * 500 - centerDistance * 400
    try {
      if (!video.paused && !video.ended) score += 1200
      if (video.readyState >= 2) score += 100
      if (video.closest && video.closest('[data-e2e="feed-active-video"]')) score += 2600
      if (video.closest && video.closest('#sliderVideo')) score += 1200
    } catch (e) {}

    return score
  }

  function getActiveVideo () {
    const candidates = []
    const seen = new Set()
    const add = function (video, priority) {
      if (!isVideoLike(video) || seen.has(video)) return
      seen.add(video)
      candidates.push({ video, priority: priority || 0 })
    }

    try {
      const player = pageWin.player || window.player
      if (player) {
        add(player.video, 2400)
        add(player.controls && player.controls.video, 2300)
        add(player._video, 2200)
        add(player._core && player._core._media, 2100)
      }
    } catch (e) {}

    activeSelectors.forEach(function (selector, index) {
      try {
        document.querySelectorAll(selector).forEach(function (video) {
          add(video, 2000 - index * 100)
        })
      } catch (e) {}
    })

    try {
      document.querySelectorAll('video').forEach(function (video) { add(video, 0) })
    } catch (e) {}

    let best = null
    let bestScore = -Infinity
    candidates.forEach(function (item) {
      const score = visibleScore(item.video, item.priority)
      if (score > bestScore) {
        bestScore = score
        best = item.video
      }
    })
    return best
  }

  function getPagePlayer () {
    try {
      return pageWin.player || window.player || null
    } catch (e) {
      return null
    }
  }

  function prePlayNowRecord (extra) {
    return Object.assign({
      perf: performance.now(),
      epoch: Date.now(),
      iso: new Date().toISOString()
    }, extra || {})
  }

  function pushPrePlayLog (record, toConsole) {
    prePlayPrimeLog.push(record)
    if (prePlayPrimeLog.length > 4000) {
      prePlayPrimeLog.splice(0, prePlayPrimeLog.length - 4000)
    }
    prePlayLastRecord = record
    if (toConsole) console.log('[h5player][DouyinPrePlayV10]', record)
  }

  function coreTypeOf (core) {
    try {
      return String((core && (core.coreType || core._coreType)) || '').toLowerCase()
    } catch (e) {
      return ''
    }
  }

  function findCoreMethodOwner (core, methodName) {
    let owner = core
    let depth = 0
    while (owner && depth < 20) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(owner, methodName)
        if (descriptor && typeof descriptor.value === 'function') {
          return { owner, descriptor, depth }
        }
        owner = Object.getPrototypeOf(owner)
      } catch (e) {
        owner = null
      }
      depth += 1
    }
    return null
  }

  function relatedCoreMethodNames (core) {
    const result = []
    let owner = core
    let depth = 0
    while (owner && depth < 8) {
      let names = []
      try { names = Object.getOwnPropertyNames(owner) } catch (e) {}
      names.forEach(function (name) {
        if (/play|worker|send|post|rate/i.test(name)) result.push(depth + ':' + name)
      })
      try { owner = Object.getPrototypeOf(owner) } catch (e) { owner = null }
      depth += 1
    }
    return Array.from(new Set(result)).slice(0, 120)
  }

  function primeMediaStreamCoreBeforePlay (core, hookStrategy) {
    const coreType = coreTypeOf(core)
    let instanceId = null
    let isLive = false
    let beforePrivate = NaN
    let beforeDefault = NaN
    try { instanceId = (core && core._instanceId) || null } catch (e) {}
    try { isLive = Boolean(core && core.isLive === true) } catch (e) {}
    try { beforePrivate = Number(core && core._playbackRate) } catch (e) {}
    try { beforeDefault = Number(core && core._defaultPlaybackRate) } catch (e) {}

    const cleanDesired = Number(desiredRate)
    let applied = null
    let primed = false
    let reason = ''

    prePlayPrimeAttemptCount += 1

    if (coreType !== 'mediastream') {
      reason = 'not_mediastream'
    } else if (isLive) {
      prePlayLiveSkipCount += 1
      reason = 'skip_live_core'
    } else if (!rateGuardActive || !Number.isFinite(cleanDesired) || cleanDesired <= 0) {
      reason = 'no_active_desired_rate'
    } else {
      /* Keep UI/state decimal-clean, but seed the exact Float32 value that the
       * WebCodecs/WASM rate path will later report back to the Worker. */
      applied = Math.fround(Math.min(16, Math.max(0.1, Number(cleanDesired.toFixed(1)))))
      try {
        core._playbackRate = applied
        primed = Object.is(Number(core._playbackRate), applied)
        reason = primed ? 'private_rate_primed_before_play' : 'private_write_not_confirmed'
        if (primed) prePlayPrimeSuccessCount += 1
      } catch (e) {
        reason = 'private_write_error:' + String((e && e.message) || e)
      }
    }

    const record = prePlayNowRecord({
      type: 'before_send_play_to_worker',
      hookStrategy,
      desiredRate: Number.isFinite(cleanDesired) ? cleanDesired : null,
      appliedRate: applied,
      beforePrivateRate: Number.isFinite(beforePrivate) ? beforePrivate : null,
      beforeDefaultRate: Number.isFinite(beforeDefault) ? beforeDefault : null,
      afterPrivateRate: (function () {
        try {
          const value = Number(core && core._playbackRate)
          return Number.isFinite(value) ? value : null
        } catch (e) { return null }
      })(),
      coreType,
      isLive,
      instanceId,
      primed,
      reason
    })
    pushPrePlayLog(record, false)
    return record
  }

  function installPrePlayOwnerHook (found, source) {
    if (!found || !found.owner || !found.descriptor || typeof found.descriptor.value !== 'function') return false
    if (prePlayHookedOwners.has(found.owner)) return true

    const owner = found.owner
    const descriptor = found.descriptor
    const original = descriptor.value
    const strategy = '_sendPlayToWorker@depth' + found.depth
    const wrapped = function () {
      primeMediaStreamCoreBeforePlay(this, strategy)
      return original.apply(this, arguments)
    }

    try {
      Object.defineProperty(owner, '_sendPlayToWorker', {
        configurable: Boolean(descriptor.configurable),
        enumerable: Boolean(descriptor.enumerable),
        writable: Boolean(descriptor.writable),
        value: wrapped
      })
    } catch (e) {
      if (descriptor.writable) {
        try { owner._sendPlayToWorker = wrapped } catch (e2) {}
      }
    }

    let installed = false
    try { installed = owner._sendPlayToWorker === wrapped } catch (e) {}
    if (!installed) {
      pushPrePlayLog(prePlayNowRecord({
        type: 'hook_install_failed',
        source,
        depth: found.depth,
        prototypeName: (function () {
          try { return (owner.constructor && owner.constructor.name) || null } catch (e) { return null }
        })(),
        configurable: Boolean(descriptor.configurable),
        writable: Boolean(descriptor.writable)
      }), true)
      return false
    }

    prePlayHookedOwners.set(owner, { original, descriptor, wrapped, depth: found.depth })
    prePlayHookInstallCount += 1
    pushPrePlayLog(prePlayNowRecord({
      type: 'hook_installed',
      source,
      depth: found.depth,
      prototypeName: (function () {
        try { return (owner.constructor && owner.constructor.name) || null } catch (e) { return null }
      })(),
      hookedPrototypeCount: prePlayHookedOwners.size
    }), true)
    return true
  }

  function scanAndInstallPrePlayHook () {
    const player = getPagePlayer()
    let core = null
    try { core = (player && player._core) || null } catch (e) {}
    const coreType = coreTypeOf(core)
    const found = core && coreType === 'mediastream' ? findCoreMethodOwner(core, '_sendPlayToWorker') : null

    const signature = [Boolean(player), Boolean(core), coreType, Boolean(found), found && found.depth, prePlayHookedOwners.size].join('|')
    if (signature !== prePlayLastScanSignature) {
      prePlayLastScanSignature = signature
      pushPrePlayLog(prePlayNowRecord({
        type: 'install_scan',
        source: 'integrated-v10',
        hasPlayer: Boolean(player),
        hasCore: Boolean(core),
        coreType: coreType || null,
        coreConstructor: (function () {
          try { return (core && core.constructor && core.constructor.name) || null } catch (e) { return null }
        })(),
        hasSendPlayToWorker: Boolean(found),
        methodDepth: found ? found.depth : null,
        hookedPrototypeCount: prePlayHookedOwners.size,
        relatedMethods: core && coreType === 'mediastream' && !found ? relatedCoreMethodNames(core) : undefined
      }), false)
    }

    if (!core || coreType !== 'mediastream' || !found) return false
    return installPrePlayOwnerHook(found, 'integrated-v10')
  }

  function exposeIntegratedPrePlayDiagnostics () {
    try {
      pageWin.__dyPreplayRatePrimeProbe = {
        name: 'H5PLAYER_DOUYIN_INTEGRATED_PREPLAY_V10',
        version: '10.1-integrated',
        integratedIntoH5playerV10: true,
        isInstalled: function () { return prePlayHookedOwners.size > 0 },
        hookCount: function () { return prePlayHookedOwners.size },
        tryInstall: scanAndInstallPrePlayHook,
        getLog: function () { return prePlayPrimeLog.slice() },
        getLastScan: function () {
          for (let i = prePlayPrimeLog.length - 1; i >= 0; i--) {
            if (prePlayPrimeLog[i] && prePlayPrimeLog[i].type === 'install_scan') return prePlayPrimeLog[i]
          }
          return null
        },
        clearLog: function () { prePlayPrimeLog.length = 0 }
      }
    } catch (e) {}
  }

  /**
   * The React player switches from a blob-backed video to a MediaStream sink
   * after the first feed items. In that mode player._core is the control plane.
   */
  function getMediaStreamContext (video) {
    const player = getPagePlayer()
    if (!player) return null

    let core = null
    let media = null
    let coreType = ''
    try { core = player._core || null } catch (e) {}
    if (!core) return null

    try {
      media = player.video || player._video || player.media || core._media || null
    } catch (e) {}

    try {
      coreType = String(core.coreType || core._coreType || '').toLowerCase()
    } catch (e) {}

    /* srcObject alone is insufficient: live/transitional media may also use it. */
    if (coreType !== 'mediastream') return null
    if (!media || !isVideoLike(media)) return null
    if (video && media !== video) return null

    try {
      const srcObject = media.srcObject
      if (srcObject && typeof srcObject.active === 'boolean' && !srcObject.active) return null
    } catch (e) {}

    return { player, core, media }
  }

  function getCorePlaybackRateAccessor (core) {
    let owner = core
    let depth = 0
    while (owner && depth < 8) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(owner, 'playbackRate')
        if (descriptor) {
          if (descriptor.get && descriptor.set) return { descriptor, depth }
          return null
        }
        owner = Object.getPrototypeOf(owner)
      } catch (e) {
        return null
      }
      depth += 1
    }
    return null
  }

  function releaseSuperRateGuard (core) {
    core = core || currentGuardedCore
    if (!core) return true

    const guard = guardedMediaStreamCores.get(core)
    if (!guard) {
      if (currentGuardedCore === core) currentGuardedCore = null
      return true
    }

    try {
      if (guard.prototypeDepth === 0 && guard.originalDescriptor) {
        Object.defineProperty(core, 'playbackRate', guard.originalDescriptor)
      } else {
        delete core.playbackRate
      }
      guardedMediaStreamCores.delete(core)
      if (currentGuardedCore === core) currentGuardedCore = null
      return true
    } catch (e) {
      console.warn('[h5player][DouyinSuperRate] guard release failed', e)
      return false
    }
  }

  function ensureSuperRateGuard (ctx) {
    const core = ctx && ctx.core
    if (!core) return false

    if (currentGuardedCore && currentGuardedCore !== core) {
      releaseSuperRateGuard(currentGuardedCore)
    }

    if (guardedMediaStreamCores.has(core)) {
      currentGuardedCore = core
      return true
    }

    const found = getCorePlaybackRateAccessor(core)
    if (!found || !found.descriptor) return false

    const descriptor = found.descriptor
    const originalGet = descriptor.get
    const originalSet = descriptor.set
    if (found.depth === 0 && descriptor.configurable === false) return false

    const guardedGetter = function () {
      return originalGet.call(this)
    }
    const guardedSetter = function (value) {
      const requested = Number(value)
      const current = Number(originalGet.call(this))
      const target = Number(desiredRate)

      if (rateGuardActive && Number.isFinite(target) && target > 3 &&
          requested === 1 && Number.isFinite(current) && current > 3) {
        blockedSuperRateResetCount += 1
        return current
      }

      return originalSet.call(this, value)
    }

    try {
      Object.defineProperty(core, 'playbackRate', {
        configurable: true,
        enumerable: Boolean(descriptor.enumerable),
        get: guardedGetter,
        set: guardedSetter
      })

      guardedMediaStreamCores.set(core, {
        originalGet,
        originalSet,
        originalDescriptor: descriptor,
        guardedGetter,
        guardedSetter,
        prototypeDepth: found.depth
      })
      currentGuardedCore = core
      return true
    } catch (e) {
      console.warn('[h5player][DouyinSuperRate] lazy guard install failed', e)
      return false
    }
  }

  function setSuperMediaStreamRate (ctx, desired, applied) {
    if (!ctx || !ctx.core) return false

    desired = Number(desired)
    applied = Number(applied)
    if (!Number.isFinite(desired) || !Number.isFinite(applied)) return false

    if (desired <= 3) {
      const guard = guardedMediaStreamCores.get(ctx.core)
      try {
        if (guard && guard.originalSet) {
          guard.originalSet.call(ctx.core, applied)
        } else {
          ctx.core.playbackRate = applied
        }
      } catch (e) {
        return false
      }
      releaseSuperRateGuard(ctx.core)
      return true
    }

    const guarded = ensureSuperRateGuard(ctx)
    const guard = guarded ? guardedMediaStreamCores.get(ctx.core) : null

    try {
      if (guard && guard.originalSet) {
        guard.originalSet.call(ctx.core, applied)
      } else {
        ctx.core.playbackRate = applied
      }
      return true
    } catch (e) {
      console.warn('[h5player][DouyinSuperRate] set super rate failed', e)
      return false
    }
  }

  function normalizeRateForActivePlayer (rate) {
    rate = Number(rate)
    if (!Number.isFinite(rate)) return NaN
    return Math.min(16, Math.max(0.1, Number(rate.toFixed(1))))
  }

  function getEffectivePlaybackRate (video) {
    const ctx = getMediaStreamContext(video)
    if (ctx) {
      try {
        const rate = Number(ctx.core.playbackRate)
        if (Number.isFinite(rate) && rate > 0) return rate
      } catch (e) {}
    }
    return video ? Number(nativeGet('playbackRate', video)) : NaN
  }

  function getEffectiveCurrentTime (video) {
    const ctx = getMediaStreamContext(video)
    if (ctx) {
      try {
        const current = Number(ctx.player.currentTime)
        if (Number.isFinite(current)) return current
      } catch (e) {}
      try {
        const current = Number(ctx.core.currentTime)
        if (Number.isFinite(current)) return current
      } catch (e) {}
    }
    return video ? Number(nativeGet('currentTime', video)) : NaN
  }

  function isProtectedLegacyVideo (video) {
    if (!rateGuardActive || desiredRate === null || !isVideoLike(video)) return false

    /* MediaStream playback is controlled by player._core. Do not fight page
     * writes on the DOM video element in that mode. */
    if (isMediaStreamLikeVideo(video) || getMediaStreamContext(video)) return false

    const active = getActiveVideo()
    return active ? active === video : !video.paused
  }

  function setNativeRate (video, rate) {
    if (!video || !Number.isFinite(rate)) return false
    const normalized = Math.min(16, Math.max(0.1, Number(rate.toFixed(1))))
    const currentDefault = Number(nativeGet('defaultPlaybackRate', video))
    const currentRate = Number(nativeGet('playbackRate', video))
    let ok = true

    if (!Number.isFinite(currentDefault) || Math.abs(currentDefault - normalized) > 0.005) {
      ok = nativeSet('defaultPlaybackRate', video, normalized) && ok
    }
    if (!Number.isFinite(currentRate) || Math.abs(currentRate - normalized) > 0.005) {
      ok = nativeSet('playbackRate', video, normalized) && ok
    }

    return ok
  }

  function setMediaStreamRate (ctx, rate) {
    if (!ctx || !ctx.core || !Number.isFinite(rate)) return false

    /*
     * AsyncQueue.changeRate uses the input Number as a unique key, while WASM
     * returns outRate through a float32 callback and completion compares with
     * strict equality. Send the exact float32 value the callback will return.
     */
    const normalized = Math.min(16, Math.max(0.1, Number(rate.toFixed(1))))
    const applied = Math.fround(normalized)
    return setSuperMediaStreamRate(ctx, normalized, applied)
  }

  function setActiveRate (video, rate) {
    const ctx = getMediaStreamContext(video)
    if (ctx) return setMediaStreamRate(ctx, rate)
    if (isMediaStreamLikeVideo(video)) return false
    return setNativeRate(video, rate)
  }

  function persistRate (rate) {
    if (!h5) return
    h5.playbackRate = rate
    try {
      configManager.set('media.playbackRate', rate)
    } catch (e) {}
  }

  function applyDesiredRateToVideo (video) {
    if (desiredRate === null || !video) return { ok: false, mode: 'none' }

    const normalized = normalizeRateForActivePlayer(desiredRate, video)
    if (!Number.isFinite(normalized)) return { ok: false, mode: 'none' }
    if (normalized !== desiredRate) {
      desiredRate = normalized
      persistRate(normalized)
    }

    const mediaStreamCtx = getMediaStreamContext(video)
    if (mediaStreamCtx) {
      if (desiredRate > 3) {
        ensureSuperRateGuard(mediaStreamCtx)
      } else {
        if (currentGuardedCore && currentGuardedCore !== mediaStreamCtx.core) {
          releaseSuperRateGuard(currentGuardedCore)
        }
        if (guardedMediaStreamCores.has(mediaStreamCtx.core)) {
          releaseSuperRateGuard(mediaStreamCtx.core)
        }
      }

      const current = Number(mediaStreamCtx.core.playbackRate)
      const applied = Math.fround(normalized)
      if (!Number.isFinite(current) || Math.abs(current - applied) > 0.005) {
        const ok = setMediaStreamRate(mediaStreamCtx, normalized)
        if (ok) mediaStreamActivationApplyCount += 1
        return { ok, mode: 'mediastream-core', applied: ok }
      }
      return { ok: true, mode: 'mediastream-core', applied: false }
    }

    if (isMediaStreamLikeVideo(video)) {
      return { ok: false, mode: 'mediastream-pending', applied: false }
    }

    if (currentGuardedCore) releaseSuperRateGuard(currentGuardedCore)

    const current = Number(nativeGet('playbackRate', video))
    if (!Number.isFinite(current) || Math.abs(current - normalized) > 0.005) {
      const ok = setActiveRate(video, normalized)
      if (ok) legacyActivationApplyCount += 1
      return { ok, mode: 'legacy-media-element', applied: ok }
    }
    return { ok: true, mode: 'legacy-media-element', applied: false }
  }

  function cancelActivationBurst () {
    activationTimers.forEach(function (timer) {
      try { rawClearTimeout(timer) } catch (e) {}
    })
    activationTimers = []
  }

  function scheduleActivationBurst (video, reason) {
    if (!rateGuardActive || desiredRate === null || !isVideoLike(video)) return false

    cancelActivationBurst()
    activationGeneration += 1
    const generation = activationGeneration
    lastActivationVideo = video
    lastActivationReason = String(reason || 'media-event')
    lastActivationAt = Date.now()

    const run = function () {
      if (generation !== activationGeneration || !rateGuardActive) return false
      if (!video.isConnected) return false
      activationAttemptCount += 1
      return applyDesiredRateToVideo(video)
    }

    run()
    activationRetryDelays.forEach(function (delay) {
      const timer = rawSetTimeout(function () {
        activationTimers = activationTimers.filter(function (item) { return item !== timer })
        if (generation !== activationGeneration || !rateGuardActive) return
        run()
      }, delay)
      activationTimers.push(timer)
    })
    return true
  }

  function applyDesiredRateNow () {
    if (desiredRate === null) return false
    const video = getActiveVideo()
    if (!video) return false
    return applyDesiredRateToVideo(video).ok
  }

  function cancelRateApplySchedule () {
    if (rateApplyTimer) {
      rawClearTimeout(rateApplyTimer)
      rateApplyTimer = null
    }
  }

  function commitDesiredRate (generation) {
    if (generation !== rateRequestGeneration) return false
    rateApplyTimer = null
    return applyDesiredRateNow()
  }

  function queueDesiredRateCommit (debounce) {
    cancelRateApplySchedule()
    rateRequestGeneration += 1
    const generation = rateRequestGeneration

    if (debounce) {
      rateApplyTimer = rawSetTimeout(function () {
        commitDesiredRate(generation)
      }, rateHotkeyDebounceMs)
      return true
    }

    return commitDesiredRate(generation)
  }

  /* Keep native getters truthful for Douyin's React state synchronization. */
  try {
    Object.defineProperty(mediaProto, 'playbackRate', {
      configurable: nativeDescriptor.playbackRate.configurable !== false,
      enumerable: nativeDescriptor.playbackRate.enumerable !== false,
      get: function () {
        return nativeDescriptor.playbackRate.get.call(this)
      },
      set: function (value) {
        const rate = Number(value)
        if (applyingDepth > 0) {
          return nativeDescriptor.playbackRate.set.call(this, value)
        }
        if (isProtectedLegacyVideo(this) && Number.isFinite(rate) && Math.abs(rate - desiredRate) > 0.005) {
          blockedLegacyRateResetCount += 1
          return
        }
        return nativeDescriptor.playbackRate.set.call(this, value)
      }
    })
  } catch (e) {
    console.warn('[h5player][DouyinNativeFix] playbackRate bridge install failed', e)
  }

  if (nativeDescriptor.defaultPlaybackRate && nativeDescriptor.defaultPlaybackRate.get && nativeDescriptor.defaultPlaybackRate.set) {
    try {
      Object.defineProperty(mediaProto, 'defaultPlaybackRate', {
        configurable: nativeDescriptor.defaultPlaybackRate.configurable !== false,
        enumerable: nativeDescriptor.defaultPlaybackRate.enumerable !== false,
        get: function () {
          return nativeDescriptor.defaultPlaybackRate.get.call(this)
        },
        set: function (value) {
          const rate = Number(value)
          if (applyingDepth > 0) {
            return nativeDescriptor.defaultPlaybackRate.set.call(this, value)
          }
          if (isProtectedLegacyVideo(this) && Number.isFinite(rate) && Math.abs(rate - desiredRate) > 0.005) {
            blockedLegacyRateResetCount += 1
            return
          }
          return nativeDescriptor.defaultPlaybackRate.set.call(this, value)
        }
      })
    } catch (e) {}
  }

  try {
    Object.defineProperty(mediaProto, 'currentTime', {
      configurable: nativeDescriptor.currentTime.configurable !== false,
      enumerable: nativeDescriptor.currentTime.enumerable !== false,
      get: function () {
        return nativeDescriptor.currentTime.get.call(this)
      },
      set: function (value) {
        if (applyingDepth > 0) {
          return nativeDescriptor.currentTime.set.call(this, value)
        }

        if (this === seekGuardVideo && Date.now() < seekGuardUntil) {
          const requested = Number(value)
          const elapsed = Math.max(0, (Date.now() - seekGuardAt) / 1000)
          const expected = seekGuardTarget + elapsed * (Number(nativeGet('playbackRate', this)) || 1)
          if (Number.isFinite(requested) && Math.abs(requested - expected) > 1.25) return
        }
        return nativeDescriptor.currentTime.set.call(this, value)
      }
    })
  } catch (e) {
    console.warn('[h5player][DouyinNativeFix] currentTime bridge install failed', e)
  }

  function setDesiredRate (rate, showTips, options) {
    rate = Number(rate)
    if (!Number.isFinite(rate)) return false

    const video = getActiveVideo()
    rate = normalizeRateForActivePlayer(rate, video)
    if (!Number.isFinite(rate)) return false

    desiredRate = rate
    rateGuardActive = Math.abs(rate - 1) > 0.005
    persistRate(rate)
    queueDesiredRateCommit(Boolean(options && options.debounce))

    if (showTips && h5 && h5.tips) {
      try {
        h5.tips(i18n.t('tipsMsg.playspeed') + rate)
      } catch (e) {
        h5.tips('播放速度：' + rate)
      }
    }
    return true
  }

  function getNativePlaybackRate (video) {
    video = video || getActiveVideo()
    return video ? Number(nativeGet('playbackRate', video)) : NaN
  }

  function getNativeCurrentTime (video) {
    video = video || getActiveVideo()
    return video ? Number(nativeGet('currentTime', video)) : NaN
  }

  function getPlaybackRate (video) {
    video = video || getActiveVideo()
    return video ? getEffectivePlaybackRate(video) : NaN
  }

  function getCurrentTime (video) {
    video = video || getActiveVideo()
    return video ? getEffectiveCurrentTime(video) : NaN
  }

  function resetDesiredRate (showTips) {
    const video = getActiveVideo()
    if (!video) return false

    const current = getEffectivePlaybackRate(video)
    let targetRate = 1
    if (Number.isFinite(current) && Math.abs(current - 1) > 0.005) {
      if (h5) h5.lastPlaybackRate = current
    } else if (h5 && Number.isFinite(Number(h5.lastPlaybackRate)) && Math.abs(Number(h5.lastPlaybackRate) - 1) > 0.005) {
      targetRate = Number(h5.lastPlaybackRate)
    }
    return setDesiredRate(targetRate, showTips)
  }

  function seekBy (delta, showTips) {
    delta = Number(delta)
    if (!Number.isFinite(delta) || delta === 0) return false
    const video = getActiveVideo()
    if (!video) return false

    const mediaStreamCtx = getMediaStreamContext(video)
    const current = getEffectiveCurrentTime(video)
    if (!Number.isFinite(current)) return false

    const rateBeforeSeek = getEffectivePlaybackRate(video)
    if (Number.isFinite(rateBeforeSeek) && rateBeforeSeek > 0) {
      desiredRate = normalizeRateForActivePlayer(rateBeforeSeek, video)
      rateGuardActive = Math.abs(desiredRate - 1) > 0.005
      persistRate(desiredRate)
    }

    let target = current + delta
    const duration = Number(video.duration)
    if (Number.isFinite(duration) && duration > 0) target = Math.min(duration, target)
    target = Math.max(0, target)

    let seekSucceeded = false
    if (mediaStreamCtx && typeof mediaStreamCtx.player.seek === 'function') {
      try {
        mediaStreamCtx.player.seek(target)
        seekSucceeded = true
      } catch (e) {
        seekSucceeded = false
      }
    } else {
      seekGuardVideo = video
      seekGuardTarget = target
      seekGuardAt = Date.now()
      seekGuardUntil = seekGuardAt + 650
      seekSucceeded = nativeSet('currentTime', video, target)

      ;[45, 140].forEach(function (delay) {
        rawSetTimeout(function () {
          if (getActiveVideo() !== video) return
          const now = Number(nativeGet('currentTime', video))
          if (!Number.isFinite(now)) return
          const progressedTarget = target + Math.max(0, (Date.now() - seekGuardAt) / 1000) * (Number(nativeGet('playbackRate', video)) || 1)
          if (Math.abs(now - progressedTarget) > 1.5) {
            nativeSet('currentTime', video, Math.min(Number.isFinite(duration) && duration > 0 ? duration : progressedTarget, progressedTarget))
          }
        }, delay)
      })
    }

    if (!seekSucceeded) return false

    if (rateGuardActive) {
      scheduleActivationBurst(video, 'seek')
    }

    if (showTips && h5 && h5.tips) {
      try {
        h5.tips((delta > 0 ? i18n.t('tipsMsg.forward') : i18n.t('tipsMsg.backward')) + Math.abs(delta) + i18n.t('tipsMsg.seconds'))
      } catch (e) {}
    }
    return true
  }

  function isEditableEventTarget (event) {
    const target = event.composedPath ? (event.composedPath()[0] || event.target) : event.target
    return target ? isEditableTarget(target) : false
  }

  function handleKeydown (event) {
    if (!h5 || !h5.enable || isEditableEventTarget(event)) return
    if (event.altKey || event.metaKey || event.shiftKey) return

    const key = String(event.key || '').toLowerCase()
    const code = String(event.code || '')
    let handled = false

    if (!event.ctrlKey && (key === 'c' || key === 'x')) {
      const video = getActiveVideo()
      if (!video) return
      const now = Date.now()
      const actualRate = getEffectivePlaybackRate(video)
      const rapidAdjust = now - lastRateHotkeyAt < 420 && Number.isFinite(Number(desiredRate))
      const base = rapidAdjust ? Number(desiredRate) : (Number.isFinite(actualRate) ? actualRate : (Number(desiredRate) || 1))
      lastRateHotkeyAt = now
      handled = setDesiredRate(base + (key === 'c' ? 0.1 : -0.1), true, { debounce: true })
    } else if (!event.ctrlKey && key === 'z') {
      handled = resetDesiredRate(true)
    } else if (!event.ctrlKey && (/^Digit[1-4]$/.test(code) || /^Numpad[1-4]$/.test(code))) {
      const rate = Number(code.slice(-1))
      /* Reuse h5player's original jump helper: a single press selects Nx,
       * a rapid second press selects 2N x, and keyboard auto-repeat continues
       * adding N until setPlaybackRate() clamps at 16x. setPlaybackRate() is
       * already routed through this bridge on Douyin, so Float32-safe Core
       * control and persistence remain intact. */
      if (h5 && typeof h5.setPlaybackRatePlus === 'function') {
        h5.setPlaybackRatePlus(rate)
        handled = true
      } else {
        handled = setDesiredRate(rate, true)
      }
    } else if (key === 'arrowright' || key === 'arrowleft') {
      const step = event.ctrlKey ? 30 : 5
      handled = seekBy(key === 'arrowright' ? step : -step, true)
    }

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
      if (event.stopImmediatePropagation) event.stopImmediatePropagation()
      return true
    }
  }

  function init (playerApi) {
    h5 = playerApi || h5
    if (runtimeInited) return true
    runtimeInited = true

    try {
      const storedRate = Number(configManager.get('media.playbackRate'))
      if (Number.isFinite(storedRate) && storedRate > 0) {
        desiredRate = Number(storedRate.toFixed(1))
        rateGuardActive = Math.abs(desiredRate - 1) > 0.005
      }
    } catch (e) {}

    window.addEventListener('keydown', handleKeydown, true)

    exposeIntegratedPrePlayDiagnostics()
    if (!prePlayScanTimer) {
      prePlayScanTimer = rawSetInterval(scanAndInstallPrePlayHook, 20)
      rawSetTimeout(scanAndInstallPrePlayHook, 0)
    }

    const mediaEventHandler = function (event) {
      if (!rateGuardActive) return
      const target = event && event.target
      if (!isVideoLike(target)) return

      const eventType = String(event.type || '')
      const directPlaybackEvent = eventType === 'play' || eventType === 'playing'
      const visiblyRelevant = !target.paused || visibleScore(target, 0) > 0
      if (directPlaybackEvent || visiblyRelevant) {
        scheduleActivationBurst(target, eventType)
      }
    }
    ;['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'durationchange'].forEach(function (eventName) {
      document.addEventListener(eventName, mediaEventHandler, true)
    })

    document.addEventListener('visibilitychange', function () {
      if (!rateGuardActive || document.hidden) return
      const video = getActiveVideo()
      if (video) scheduleActivationBurst(video, 'visibilitychange')
    }, true)

    rawSetInterval(function () {
      if (!rateGuardActive || document.hidden) return
      const video = getActiveVideo()
      if (video) applyDesiredRateToVideo(video)
    }, 1500)

    try {
      pageWin.__h5DouyinNativeFix = {
        version: bridgeVersion,
        snapshot,
        setRate: function (rate) { return setDesiredRate(rate, false) },
        seekBy: function (delta) { return seekBy(delta, false) },
        resetRate: function () { return resetDesiredRate(false) },
        getRate: function () { return getPlaybackRate() },
        getTime: function () { return getCurrentTime() },
        build: 'v10.1-preplay-numeric-jump-restored',
        float32RateFix: true,
        prePlayPrimeIntegrated: true,
        eventTargetedActivation: true,
        continuousMutationObserver: false
      }
    } catch (e) {}

    if (rateGuardActive) {
      rawSetTimeout(function () {
        const video = getActiveVideo()
        if (video) scheduleActivationBurst(video, 'init')
      }, 0)
    }
    return true
  }

  function snapshot () {
    const video = getActiveVideo()
    let rect = null
    try {
      rect = video && video.getBoundingClientRect
        ? (video.getBoundingClientRect().toJSON ? video.getBoundingClientRect().toJSON() : video.getBoundingClientRect())
        : null
    } catch (e) {}
    const mediaStreamCtx = video ? getMediaStreamContext(video) : null
    return {
      enabled: true,
      bridgeVersion,
      desiredRate,
      rateGuardActive,
      mode: mediaStreamCtx ? 'mediastream-core' : 'legacy-media-element',
      effectivePlaybackRate: video ? getEffectivePlaybackRate(video) : null,
      nativePlaybackRate: video ? getNativePlaybackRate(video) : null,
      corePlaybackRate: mediaStreamCtx ? Number(mediaStreamCtx.core.playbackRate) : null,
      superRateGuardInstalled: Boolean(mediaStreamCtx && guardedMediaStreamCores.has(mediaStreamCtx.core)),
      blockedSuperRateResetCount,
      pendingRateCommit: Boolean(rateApplyTimer),
      rateRequestGeneration,
      rateHotkeyDebounceMs,
      activationGeneration,
      activationPendingTimers: activationTimers.length,
      lastActivationReason,
      lastActivationAt,
      lastActivationVideoIsActive: Boolean(video && lastActivationVideo === video),
      activationAttemptCount,
      mediaStreamActivationApplyCount,
      legacyActivationApplyCount,
      blockedLegacyRateResetCount,
      activationStrategy: 'event-targeted-burst',
      continuousMutationObserver: false,
      fallbackIntervalMs: 1500,
      float32RateFix: true,
      delayedRateRetries: false,
      currentCoreGuarded: Boolean(mediaStreamCtx && currentGuardedCore === mediaStreamCtx.core),
      prePlayPrimeIntegrated: true,
      prePlayHookInstalled: prePlayHookedOwners.size > 0,
      prePlayHookCount: prePlayHookedOwners.size,
      prePlayHookInstallCount,
      prePlayPrimeAttemptCount,
      prePlayPrimeSuccessCount,
      prePlayLiveSkipCount,
      prePlayLastRecord,
      defaultPlaybackRate: video && nativeDescriptor.defaultPlaybackRate && nativeDescriptor.defaultPlaybackRate.get
        ? Number(nativeDescriptor.defaultPlaybackRate.get.call(video))
        : null,
      currentTime: video ? getEffectiveCurrentTime(video) : null,
      nativeCurrentTime: video ? getNativeCurrentTime(video) : null,
      paused: video ? Boolean(video.paused) : null,
      readyState: video ? video.readyState : null,
      activeVideo: video,
      rect,
      videoCount: document.querySelectorAll('video').length,
      player: getPagePlayer()
    }
  }

  return {
    enabled: true,
    init,
    getActiveVideo,
    getNativePlaybackRate,
    getNativeCurrentTime,
    getPlaybackRate,
    getCurrentTime,
    setDesiredRate,
    resetDesiredRate,
    seekBy,
    snapshot
  }
}

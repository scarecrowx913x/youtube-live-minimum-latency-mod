// ==UserScript==
// @name         YouTube Live Minimum Latency - Modified
// @description  YouTube Live の遅延を検出し、一時的に再生速度を上げてライブ位置へ追いつきやすくします。
// @namespace    https://github.com/scarecrowx913x/youtube-live-minimum-latency-mod
// @version      0.1.0-mod.17
// @author       Sigsign (original concept), modified by scarecrowx913x
// @license      MIT
// @match        https://www.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/scarecrowx913x/youtube-live-minimum-latency-mod/main/youtube-live-minimum-latency.user.js
// @downloadURL  https://raw.githubusercontent.com/scarecrowx913x/youtube-live-minimum-latency-mod/main/youtube-live-minimum-latency.user.js
// ==/UserScript==

/*
 * YouTube Live Minimum Latency - Modified
 *
 * Original:
 *   YouTube Live minimum latency by Sigsign
 *   https://greasyfork.org/en/scripts/427483-youtube-live-minimum-latency
 *
 * Notes:
 *   - This script only runs on youtube.com.
 *   - It does not use external network requests.
 *   - It does not store personal data.
 *
 * v0.1.0-mod.17 Changes:
 *   - Add buffer-aware playback rate caps and safer stop thresholds to avoid
 *     outrunning the live buffer on low-latency streams.
 *   - Stop acceleration after starvation-related media events.
 *
 * v0.1.0-mod.16 Changes:
 *   - Add acceleration hysteresis, minimum acceleration time, and cooldown
 *
 * v0.1.0-mod.15 Changes:
 *   - Fix snapToAvailableRate snapping down: prefer nearest-above to avoid disabling acceleration
 *   - Fix handleNavigateStart: reset playback rate before clearing state.accelerating
 *   - Fix handleBufferOnlyFallback: apply snapToAvailableRate to buffer-fallback rate
 *   - Fix waitingTickMs fast-retry: only on watch/live pages, not all YouTube pages
 *
 * v0.1.0-mod.14 Changes:
 *   - Switch @run-at to document-start; add yt-navigate-start cleanup
 *   - Fast retry when player/video not yet in DOM
 *   - Snap acceleration rate to YouTube-supported values via getAvailablePlaybackRates()
 *   - Track video element and handlers in state; remove old listeners on video replacement
 *
 * v0.1.0-mod.13 Changes:
 *   - Fix multi-stage playback rate selection order
 *   - Use actual latency for acceleration decisions instead of latency + buffer
 *
 * v0.1.0-mod.12 Changes:
 *   - Multi-stage playback rate adjustment based on latency
 *   - Performance optimizations: reduced DOM queries, event listener cleanup
 *   - Dynamic polling interval based on buffer state
 */

(() => {
  'use strict';

  const DEBUG_STORAGE_KEY = 'yt_lml_debug';
  const PLAYER_CACHE_KEY = '__ytLmlPlayerCache';
  const VIDEO_CACHE_KEY = '__ytLmlVideoCache';

  const CONFIG = Object.freeze({
    normalRate: 1.0,
    // Multi-stage acceleration: latencySec -> playbackRate
    accelerationStages: Object.freeze([
      { latencyThreshold: 3.0, playbackRate: 1.1 },   // 3-5s: mild acceleration
      { latencyThreshold: 5.0, playbackRate: 1.15 },  // 5-10s: moderate acceleration
      { latencyThreshold: 10.0, playbackRate: 1.25 }, // 10+s: stronger acceleration
    ]),
    idleTickMs: 60 * 1000,
    activeTickMs: 500,
    bufferLowTickMs: 2000,
    waitingTickMs: 500, // fast retry when player/video not yet in DOM
    maxManualLatencySec: 120,
    seekableFallbackMaxSec: 60,
    requiredBufferFloorSec: 1.0,
    minAccelerationMs: 8000,
    accelerationCooldownMs: 5000,
    stopLatencyMarginSec: 0.75,
    startBufferMarginSec: 0.5,
    selfRateChangeIgnoreMs: 1000,
    debug: false,
    debugIntervalMs: 2000,

    bufferRateCaps: Object.freeze([
      { bufferThreshold: 1.5, maxPlaybackRate: 1.0 },
      { bufferThreshold: 3.0, maxPlaybackRate: 1.1 },
      { bufferThreshold: 5.0, maxPlaybackRate: 1.15 },
      { bufferThreshold: Infinity, maxPlaybackRate: 1.25 },
    ]),

    thresholds: Object.freeze({
      ultraLow: Object.freeze({ latencySec: 2.0, bufferSec: 1.0 }),
      low: Object.freeze({ latencySec: 3.0, bufferSec: 2.0 }),
      normal: Object.freeze({ latencySec: 10.0, bufferSec: 2.0 }),
      premiere: Object.freeze({ latencySec: 10.0, bufferSec: 2.0 }),
      unknown: Object.freeze({ latencySec: 3.0, bufferSec: 2.0 }),
    }),

    cacheTtlMs: 100,
  });

  const state = {
    timerId: null,
    currentTickMs: null,
    lastUrl: location.href,
    accelerating: false,
    accelerationStartedAt: 0,
    lastAccelerationStoppedAt: 0,
    lastDebugAt: 0,
    lastStatus: null,
    lastRequestedRate: null,
    lastRateSetAt: 0,
    playerCache: { value: null, timestamp: 0 },
    videoCache: { value: null, timestamp: 0 },
    // Video element and its bound handlers for explicit removal
    currentVideo: null,
    videoHandlers: null,
  };

  function isDebugEnabled() {
    return CONFIG.debug || window.localStorage?.getItem(DEBUG_STORAGE_KEY) === '1';
  }

  function log(...args) {
    if (isDebugEnabled()) {
      console.debug('[YT Live Minimum Latency]', ...args);
    }
  }

  function publishStatus(status) {
    state.lastStatus = status;

    if (!isDebugEnabled()) {
      return;
    }

    const now = Date.now();
    if (now - state.lastDebugAt < CONFIG.debugIntervalMs) {
      return;
    }

    state.lastDebugAt = now;
    console.debug('[YT Live Minimum Latency] status', status);
  }

  function getPlayer() {
    const now = Date.now();
    if (now - state.playerCache.timestamp < CONFIG.cacheTtlMs && state.playerCache.value) {
      return state.playerCache.value;
    }

    const player = document.querySelector('#movie_player');
    state.playerCache = { value: player, timestamp: now };
    return player;
  }

  function getVideo(player = getPlayer()) {
    const now = Date.now();
    if (now - state.videoCache.timestamp < CONFIG.cacheTtlMs && state.videoCache.value) {
      return state.videoCache.value;
    }

    const video = (
      document.querySelector('video.html5-main-video') ||
      player?.querySelector?.('video') ||
      document.querySelector('video')
    );

    state.videoCache = { value: video, timestamp: now };
    return video;
  }

  function invalidateCaches() {
    state.playerCache.timestamp = 0;
    state.videoCache.timestamp = 0;
  }

  function callPlayer(player, methodName, ...args) {
    if (!player || typeof player[methodName] !== 'function') {
      return undefined;
    }

    try {
      return player[methodName](...args);
    } catch (error) {
      log(`${methodName} failed`, error);
      return undefined;
    }
  }

  function getVideoStats(player) {
    const stats = callPlayer(player, 'getVideoStats');
    return stats && typeof stats === 'object' ? stats : null;
  }

  function getVideoData(player) {
    const data = callPlayer(player, 'getVideoData');
    return data && typeof data === 'object' ? data : null;
  }

  function isStatsLiveValue(value) {
    return value === 'live' || value === 'dvr' || value === 'lp';
  }

  function isLivePlayback(player, video, stats) {
    const videoData = getVideoData(player);

    return Boolean(
      videoData?.isLive ||
      videoData?.isLiveContent ||
      isStatsLiveValue(stats?.live) ||
      video?.duration === Infinity
    );
  }

  function isPlainLivePlayback(player, video, stats) {
    const videoData = getVideoData(player);

    return Boolean(
      videoData?.isLive ||
      videoData?.isLiveContent ||
      stats?.live === 'live' ||
      video?.duration === Infinity
    );
  }

  function getLatencyClassKey(latencyClass) {
    const value = String(latencyClass || '').toLowerCase();

    if (value.includes('ultra')) {
      return 'ultraLow';
    }

    if (value.includes('low')) {
      return 'low';
    }

    if (value.includes('normal')) {
      return 'normal';
    }

    return 'unknown';
  }

  function getThreshold(stats) {
    const thresholdKey = getLatencyClassKey(stats?.latency_class);
    const base = CONFIG.thresholds[thresholdKey] || CONFIG.thresholds.unknown;

    const threshold = { ...base, key: thresholdKey };

    if (stats?.live === 'lp') {
      return { ...threshold, ...CONFIG.thresholds.premiere, key: 'premiere' };
    }

    return threshold;
  }

  function getStatsBufferHealthSec(stats) {
    const bufferRange = stats?.vbu;
    if (typeof bufferRange !== 'string') {
      return null;
    }

    const buffer = bufferRange.split('-');
    if (buffer.length < 2) {
      return null;
    }

    const bufferTime = Number(buffer.at(-1));
    const currentTime = Number(stats?.vct);

    if (!Number.isFinite(bufferTime) || !Number.isFinite(currentTime)) {
      return null;
    }

    return Math.max(0, bufferTime - currentTime);
  }

  function getBufferedAheadSec(video, stats) {
    const statsBuffer = getStatsBufferHealthSec(stats);
    if (Number.isFinite(statsBuffer)) {
      return statsBuffer;
    }

    if (!video?.buffered?.length) {
      return 0;
    }

    const currentTime = Number(video.currentTime);
    if (!Number.isFinite(currentTime)) {
      return 0;
    }

    let bestEnd = currentTime;

    for (let i = 0; i < video.buffered.length; i += 1) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);

      if (start <= currentTime && currentTime <= end) {
        bestEnd = Math.max(bestEnd, end);
      }
    }

    return Math.max(0, bestEnd - currentTime);
  }

  function getSeekableEdgeSec(video) {
    if (!video?.seekable?.length) {
      return null;
    }

    try {
      return video.seekable.end(video.seekable.length - 1);
    } catch (error) {
      log('seekable.end failed', error);
      return null;
    }
  }

  function getMediaReferenceLatencySec(player) {
    const mediaReferenceTime = Number(callPlayer(player, 'getMediaReferenceTime'));
    const currentWallClockSec = Date.now() / 1000;

    if (!Number.isFinite(mediaReferenceTime) || mediaReferenceTime <= 0) {
      return null;
    }

    const latencySec = currentWallClockSec - mediaReferenceTime;

    if (!Number.isFinite(latencySec) || latencySec < 0) {
      return null;
    }

    return latencySec;
  }

  function getSeekableLatencyFallbackSec(video, stats) {
    const seekableEdge = getSeekableEdgeSec(video);
    const currentTimeFromStats = Number(stats?.vct);
    const currentTime = Number.isFinite(currentTimeFromStats)
      ? currentTimeFromStats
      : Number(video?.currentTime);

    if (!Number.isFinite(seekableEdge) || !Number.isFinite(currentTime)) {
      return null;
    }

    const latencySec = Math.max(0, seekableEdge - currentTime);

    if (latencySec > CONFIG.seekableFallbackMaxSec) {
      return null;
    }

    return latencySec;
  }

  function getLiveLatencySec(player, video, stats) {
    const mediaReferenceLatency = getMediaReferenceLatencySec(player);
    if (Number.isFinite(mediaReferenceLatency)) {
      return mediaReferenceLatency;
    }

    return getSeekableLatencyFallbackSec(video, stats);
  }

  function getEffectiveLatencySec(latencySec, bufferSec) {
    if (Number.isFinite(latencySec) && Number.isFinite(bufferSec)) {
      return latencySec + bufferSec;
    }

    if (Number.isFinite(latencySec)) {
      return latencySec;
    }

    return null;
  }

  function getOptimalPlaybackRate(latencySec) {
    if (!Number.isFinite(latencySec)) {
      return CONFIG.normalRate;
    }

    for (const stage of CONFIG.accelerationStages.slice().reverse()) {
      if (latencySec >= stage.latencyThreshold) {
        return stage.playbackRate;
      }
    }

    return CONFIG.normalRate;
  }

  // Snap rate to nearest available rate >= desired; only falls back to overall nearest if nothing is above.
  // Prevents snapping down (e.g. 1.1 → 1.0) which would silently disable acceleration.
  function snapToAvailableRate(rate, availableRates) {
    if (!availableRates.length || availableRates.includes(rate)) {
      return rate;
    }

    const above = availableRates.filter(r => r >= rate);
    if (above.length) {
      return above.reduce((prev, curr) => curr < prev ? curr : prev);
    }

    return availableRates.reduce((prev, curr) =>
      Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev
    );
  }

  function getAvailablePlaybackRates(player) {
    const rates = callPlayer(player, 'getAvailablePlaybackRates');
    return Array.isArray(rates)
      ? rates.map(Number).filter((rate) => Number.isFinite(rate) && rate > 0).sort((a, b) => a - b)
      : [];
  }

  function getHighestAvailableRateAtOrBelow(availableRates, targetRate) {
    if (!availableRates.length) {
      return targetRate;
    }

    const safeRate = availableRates
      .filter((rate) => rate <= targetRate + 0.001)
      .at(-1);

    return Number.isFinite(safeRate) ? safeRate : CONFIG.normalRate;
  }

  function getMaxPlaybackRateForBuffer(bufferSec) {
    if (!Number.isFinite(bufferSec)) {
      return CONFIG.normalRate;
    }

    const cap = CONFIG.bufferRateCaps.find((entry) => bufferSec < entry.bufferThreshold);
    return cap?.maxPlaybackRate ?? CONFIG.normalRate;
  }

  function getSafePlaybackRateFromAvailableRates(availableRates, requestedRate, bufferSec) {
    const bufferCappedRate = Math.min(requestedRate, getMaxPlaybackRateForBuffer(bufferSec));
    return getHighestAvailableRateAtOrBelow(availableRates, bufferCappedRate);
  }

  function getStartBufferThresholdSec(threshold) {
    return threshold.bufferSec + CONFIG.startBufferMarginSec;
  }

  function getStopBufferThresholdSec(threshold) {
    return Math.max(CONFIG.requiredBufferFloorSec, threshold.bufferSec);
  }

  function getPlayerPlaybackRate(player) {
    const playerRate = Number(callPlayer(player, 'getPlaybackRate'));
    return Number.isFinite(playerRate) && playerRate > 0 ? playerRate : null;
  }

  function getActualPlaybackRate(video) {
    const videoRate = Number(video?.playbackRate);
    return Number.isFinite(videoRate) && videoRate > 0 ? videoRate : CONFIG.normalRate;
  }

  function setVideoPlaybackRate(video, rate) {
    if (!video) {
      return false;
    }

    try {
      video.playbackRate = rate;
    } catch (error) {
      log('video.playbackRate assignment failed', error);
    }

    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      descriptor?.set?.call(video, rate);
    } catch (error) {
      log('native playbackRate setter failed', error);
    }

    return Math.abs(getActualPlaybackRate(video) - rate) <= 0.01;
  }

  function setPlaybackRate(player, video, rate) {
    state.lastRequestedRate = rate;
    state.lastRateSetAt = Date.now();

    callPlayer(player, 'setPlaybackRate', rate);
    setVideoPlaybackRate(video, rate);

    return Math.abs(getActualPlaybackRate(video) - rate) <= 0.01;
  }

  function enforcePlaybackRate(player, video, rate) {
    if (Math.abs(getActualPlaybackRate(video) - rate) <= 0.01) {
      return true;
    }

    return setPlaybackRate(player, video, rate);
  }

  function getAccelerationElapsedMs(now = Date.now()) {
    if (!state.accelerating || !state.accelerationStartedAt) {
      return 0;
    }

    return now - state.accelerationStartedAt;
  }

  function isAccelerationCooldownActive(now = Date.now()) {
    return (
      state.lastAccelerationStoppedAt > 0 &&
      now - state.lastAccelerationStoppedAt < CONFIG.accelerationCooldownMs
    );
  }

  function restartTimer(delayMs) {
    if (state.timerId) {
      clearInterval(state.timerId);
    }

    state.currentTickMs = delayMs;
    state.timerId = window.setInterval(tick, delayMs);
  }

  function updateTickInterval(bufferSec) {
    let nextTickMs = CONFIG.idleTickMs;

    if (state.accelerating) {
      nextTickMs = CONFIG.activeTickMs;
    } else if (Number.isFinite(bufferSec) && bufferSec < CONFIG.requiredBufferFloorSec * 2) {
      nextTickMs = CONFIG.bufferLowTickMs;
    }

    if (state.currentTickMs !== nextTickMs) {
      restartTimer(nextTickMs);
    }
  }

  function startAcceleration(player, video, targetRate, reason) {
    if (state.accelerating && Math.abs(getActualPlaybackRate(video) - targetRate) <= 0.01) {
      return true;
    }

    if (setPlaybackRate(player, video, targetRate)) {
      if (!state.accelerating) {
        state.accelerationStartedAt = Date.now();
      }
      state.accelerating = true;
      updateTickInterval(0);
      log('accelerating to', targetRate, reason);
      return true;
    }

    log('failed to accelerate to', targetRate, reason);
    return false;
  }

  function stopAcceleration(player, video, reason) {
    if (!state.accelerating) {
      return;
    }

    if (setPlaybackRate(player, video, CONFIG.normalRate)) {
      state.accelerating = false;
      state.accelerationStartedAt = 0;
      state.lastAccelerationStoppedAt = Date.now();
      updateTickInterval(null);
      log('normal speed', reason);
    } else {
      log('failed to return normal speed', reason);
    }
  }

  function shouldStopForLatency(latencySec, threshold, accelerationElapsedMs) {
    const stopLatencySec = Math.max(0, threshold.latencySec - CONFIG.stopLatencyMarginSec);

    return (
      accelerationElapsedMs >= CONFIG.minAccelerationMs &&
      latencySec <= stopLatencySec
    );
  }

  function handleBufferOnlyFallback(player, video, status) {
    const now = Date.now();
    const startBufferSec = getStartBufferThresholdSec(status.threshold);
    const stopBufferSec = getStopBufferThresholdSec(status.threshold);
    const targetRate = getSafePlaybackRateFromAvailableRates(
      status.availableRates,
      CONFIG.accelerationStages[1].playbackRate,
      status.bufferSec
    );

    if (!isPlainLivePlayback(player, video, getVideoStats(player))) {
      publishStatus({ ...status, reason: 'latency-unavailable' });
      updateTickInterval(status.bufferSec);
      return;
    }

    if (!state.accelerating) {
      if (isAccelerationCooldownActive(now)) {
        publishStatus({
          ...status,
          reason: 'acceleration-cooldown-buffer-fallback',
          accelerationCooldownRemainingMs: CONFIG.accelerationCooldownMs - (now - state.lastAccelerationStoppedAt),
        });
        updateTickInterval(status.bufferSec);
        return;
      }

      if (status.bufferSec >= startBufferSec && targetRate > CONFIG.normalRate) {
        const changed = startAcceleration(player, video, targetRate, {
          bufferSec: status.bufferSec,
          startBufferSec,
          targetRate,
          threshold: status.threshold,
          fallback: 'buffer-only',
        });
        publishStatus({
          ...status,
          reason: changed ? 'accelerating-started-buffer-fallback' : 'accelerating-failed-buffer-fallback',
          actualPlaybackRateAfter: getActualPlaybackRate(video),
          playerPlaybackRateAfter: getPlayerPlaybackRate(player),
        });
        return;
      }

      publishStatus({ ...status, reason: 'latency-unavailable-buffer-below-threshold' });
      updateTickInterval(status.bufferSec);
      return;
    }

    if (status.bufferSec <= stopBufferSec) {
      stopAcceleration(player, video, {
        bufferSec: status.bufferSec,
        threshold: status.threshold,
        fallback: 'buffer-only',
      });
      publishStatus({
        ...status,
        reason: 'acceleration-stopped-buffer-fallback',
        actualPlaybackRateAfter: getActualPlaybackRate(video),
        playerPlaybackRateAfter: getPlayerPlaybackRate(player),
      });
      return;
    }

    if (targetRate <= CONFIG.normalRate) {
      stopAcceleration(player, video, {
        bufferSec: status.bufferSec,
        targetRate,
        threshold: status.threshold,
        fallback: 'buffer-only-rate-capped',
      });
      publishStatus({
        ...status,
        reason: 'acceleration-stopped-buffer-rate-cap-fallback',
        actualPlaybackRateAfter: getActualPlaybackRate(video),
        playerPlaybackRateAfter: getPlayerPlaybackRate(player),
      });
      return;
    }

    const enforced = enforcePlaybackRate(player, video, targetRate);
    publishStatus({
      ...status,
      reason: enforced ? 'accelerating-continued-buffer-fallback' : 'accelerating-rate-enforce-failed-buffer-fallback',
      actualPlaybackRateAfter: getActualPlaybackRate(video),
      playerPlaybackRateAfter: getPlayerPlaybackRate(player),
    });
  }

  function cleanupVideoListeners() {
    const { currentVideo, videoHandlers } = state;
    if (!currentVideo || !videoHandlers) {
      return;
    }

    currentVideo.removeEventListener('playing', videoHandlers.onPlay, false);
    currentVideo.removeEventListener('play', videoHandlers.onPlay, false);
    currentVideo.removeEventListener('ended', videoHandlers.onEnded, false);
    currentVideo.removeEventListener('waiting', videoHandlers.onWaiting, false);
    currentVideo.removeEventListener('stalled', videoHandlers.onStalled, false);
    currentVideo.removeEventListener('seeking', videoHandlers.onSeeking, false);
    currentVideo.removeEventListener('ratechange', videoHandlers.onRateChange, false);
    state.currentVideo = null;
    state.videoHandlers = null;
  }

  function stopForStarvationEvent(eventType) {
    const player = getPlayer();
    const video = getVideo(player);
    const wasAccelerating = state.accelerating;

    if (player && video) {
      stopAcceleration(player, video, eventType);
      if (!wasAccelerating) {
        state.lastAccelerationStoppedAt = Date.now();
      }
      updateTickInterval(getBufferedAheadSec(video, getVideoStats(player)));
    } else {
      state.lastAccelerationStoppedAt = Date.now();
    }

    publishStatus({
      ...(state.lastStatus || {}),
      reason: 'starvation-cooldown-started',
      eventType,
      accelerationCooldownRemainingMs: CONFIG.accelerationCooldownMs,
      actualPlaybackRateAfter: getActualPlaybackRate(video),
      playerPlaybackRateAfter: getPlayerPlaybackRate(player),
    });
  }

  function handleSeekingEvent() {
    const player = getPlayer();
    const video = getVideo(player);
    const wasAccelerating = state.accelerating;

    if (player && video) {
      stopAcceleration(player, video, 'seeking');
      if (!wasAccelerating) {
        state.lastAccelerationStoppedAt = Date.now();
      }
    } else {
      state.lastAccelerationStoppedAt = Date.now();
    }

    invalidateCaches();
    tick();
  }

  function handleRateChangeEvent() {
    if (Date.now() - state.lastRateSetAt <= CONFIG.selfRateChangeIgnoreMs) {
      return;
    }

    const player = getPlayer();
    const video = getVideo(player);
    const actualRate = getActualPlaybackRate(video);

    if (state.accelerating && Math.abs(actualRate - state.lastRequestedRate) > 0.01) {
      stopAcceleration(player, video, 'external-ratechange');
      publishStatus({
        ...(state.lastStatus || {}),
        reason: 'external-ratechange-cooldown-started',
        actualPlaybackRateAfter: getActualPlaybackRate(video),
        playerPlaybackRateAfter: getPlayerPlaybackRate(player),
      });
    }
  }

  function ensureVideoListeners(video) {
    if (!video) {
      return;
    }

    if (state.currentVideo === video) {
      return;
    }

    // Video element changed — remove old listeners first
    cleanupVideoListeners();

    const onPlay = () => tick();
    const onEnded = () => { invalidateCaches(); tick(); };
    const onWaiting = () => stopForStarvationEvent('waiting');
    const onStalled = () => stopForStarvationEvent('stalled');
    const onSeeking = () => handleSeekingEvent();
    const onRateChange = () => handleRateChangeEvent();

    video.addEventListener('playing', onPlay, false);
    video.addEventListener('play', onPlay, false);
    video.addEventListener('ended', onEnded, false);
    video.addEventListener('waiting', onWaiting, false);
    video.addEventListener('stalled', onStalled, false);
    video.addEventListener('seeking', onSeeking, false);
    video.addEventListener('ratechange', onRateChange, false);

    state.currentVideo = video;
    state.videoHandlers = { onPlay, onEnded, onWaiting, onStalled, onSeeking, onRateChange };
  }

  function tick() {
    const player = getPlayer();
    const video = getVideo(player);

    if (!player || !video) {
      publishStatus({ reason: 'waiting-player-or-video', hasPlayer: Boolean(player), hasVideo: Boolean(video) });
      // Fast retry only on watch pages; elsewhere keep the idle interval to avoid CPU churn
      const isWatchPage = location.pathname === '/watch' || location.pathname.startsWith('/live/');
      if (isWatchPage && state.currentTickMs !== CONFIG.waitingTickMs) {
        restartTimer(CONFIG.waitingTickMs);
      }
      return;
    }

    ensureVideoListeners(video);

    const stats = getVideoStats(player);
    const videoData = getVideoData(player);
    const isLive = isLivePlayback(player, video, stats);

    if (!isLive) {
      stopAcceleration(player, video, 'not live');
      publishStatus({ reason: 'not-live', statsLive: stats?.live, videoDuration: video.duration, videoData });
      updateTickInterval(null);
      return;
    }

    if (video.paused || video.ended) {
      stopAcceleration(player, video, 'paused or ended');
      publishStatus({ reason: 'paused-or-ended', paused: video.paused, ended: video.ended });
      updateTickInterval(null);
      return;
    }

    const latencySec = getLiveLatencySec(player, video, stats);
    const bufferSec = getBufferedAheadSec(video, stats);
    const effectiveLatencySec = getEffectiveLatencySec(latencySec, bufferSec);
    const threshold = getThreshold(stats);
    const availableRates = getAvailablePlaybackRates(player);
    const actualPlaybackRate = getActualPlaybackRate(video);
    const playerPlaybackRate = getPlayerPlaybackRate(player);
    const optimalRate = getOptimalPlaybackRate(latencySec);
    const safeOptimalRate = getSafePlaybackRateFromAvailableRates(availableRates, optimalRate, bufferSec);
    const startBufferSec = getStartBufferThresholdSec(threshold);
    const stopBufferSec = getStopBufferThresholdSec(threshold);
    const now = Date.now();
    const accelerationElapsedMs = getAccelerationElapsedMs(now);
    const accelerationCooldownRemainingMs = isAccelerationCooldownActive(now)
      ? CONFIG.accelerationCooldownMs - (now - state.lastAccelerationStoppedAt)
      : 0;

    const status = {
      reason: 'checking',
      accelerating: state.accelerating,
      accelerationElapsedMs,
      accelerationCooldownRemainingMs,
      latencySec,
      bufferSec,
      effectiveLatencySec,
      optimalRate,
      safeOptimalRate,
      startBufferSec,
      stopBufferSec,
      threshold,
      playbackRate: actualPlaybackRate,
      videoPlaybackRate: actualPlaybackRate,
      playerPlaybackRate,
      availableRates,
      statsLive: stats?.live,
      latencyClass: stats?.latency_class,
      currentTime: video.currentTime,
      statsCurrentTime: stats?.vct,
      mediaReferenceLatency: getMediaReferenceLatencySec(player),
      seekableEdge: getSeekableEdgeSec(video),
      seekableLatencyFallback: getSeekableLatencyFallbackSec(video, stats),
      pollingMs: state.currentTickMs,
      pollingMode: state.accelerating ? 'active' : 'idle',
    };

    if (latencySec == null) {
      handleBufferOnlyFallback(player, video, status);
      return;
    }

    if (stats?.live !== 'live' && latencySec >= CONFIG.maxManualLatencySec) {
      stopAcceleration(player, video, 'manual latency assumed');
      publishStatus({ ...status, reason: 'manual-latency-assumed' });
      updateTickInterval(bufferSec);
      return;
    }

    if (!state.accelerating && Math.abs(actualPlaybackRate - CONFIG.normalRate) > 0.01) {
      publishStatus({ ...status, reason: 'manual-playback-rate-detected' });
      updateTickInterval(bufferSec);
      return;
    }

    if (!state.accelerating) {
      if (accelerationCooldownRemainingMs > 0) {
        publishStatus({ ...status, reason: 'acceleration-cooldown' });
        updateTickInterval(bufferSec);
        return;
      }

      if (latencySec > threshold.latencySec && bufferSec >= startBufferSec && safeOptimalRate > CONFIG.normalRate) {
        const changed = startAcceleration(player, video, safeOptimalRate, {
          latencySec,
          bufferSec,
          effectiveLatencySec,
          optimalRate,
          safeOptimalRate,
          startBufferSec,
          threshold,
        });
        publishStatus({
          ...status,
          reason: changed ? 'accelerating-started' : 'accelerating-failed',
          actualPlaybackRateAfter: getActualPlaybackRate(video),
          playerPlaybackRateAfter: getPlayerPlaybackRate(player),
        });
        return;
      }

      publishStatus({ ...status, reason: 'below-threshold' });
      updateTickInterval(bufferSec);
      return;
    }

    const currentTargetRate = getSafePlaybackRateFromAvailableRates(availableRates, getOptimalPlaybackRate(latencySec), bufferSec);
    const shouldStop = (
      shouldStopForLatency(latencySec, threshold, accelerationElapsedMs) ||
      bufferSec <= stopBufferSec ||
      currentTargetRate <= CONFIG.normalRate
    );

    if (shouldStop) {
      const stopLatencySec = Math.max(0, threshold.latencySec - CONFIG.stopLatencyMarginSec);
      stopAcceleration(player, video, {
        latencySec,
        bufferSec,
        effectiveLatencySec,
        currentTargetRate,
        threshold,
        stopLatencySec,
        accelerationElapsedMs,
      });
      publishStatus({
        ...status,
        reason: 'acceleration-stopped',
        stopLatencySec,
        actualPlaybackRateAfter: getActualPlaybackRate(video),
        playerPlaybackRateAfter: getPlayerPlaybackRate(player),
      });
      return;
    }

    if (Math.abs(currentTargetRate - actualPlaybackRate) > 0.01) {
      enforcePlaybackRate(player, video, currentTargetRate);
      publishStatus({
        ...status,
        reason: 'acceleration-rate-adjusted',
        actualPlaybackRateAfter: getActualPlaybackRate(video),
        playerPlaybackRateAfter: getPlayerPlaybackRate(player),
      });
      updateTickInterval(bufferSec);
      return;
    }

    const enforced = enforcePlaybackRate(player, video, currentTargetRate);
    publishStatus({
      ...status,
      reason: enforced ? 'accelerating-continued' : 'accelerating-rate-enforce-failed',
      actualPlaybackRateAfter: getActualPlaybackRate(video),
      playerPlaybackRateAfter: getPlayerPlaybackRate(player),
    });
    updateTickInterval(bufferSec);
  }

  function startLoop() {
    restartTimer(state.accelerating ? CONFIG.activeTickMs : CONFIG.idleTickMs);
    tick();
  }

  function handleNavigateStart() {
    cleanupVideoListeners();
    // Reset playback rate before the player may disappear, then clear state
    if (state.accelerating) {
      const player = getPlayer();
      const video = getVideo(player);
      if (player && video) {
        setPlaybackRate(player, video, CONFIG.normalRate);
      }
      state.accelerating = false;
      state.accelerationStartedAt = 0;
      state.lastAccelerationStoppedAt = 0;
    }
    invalidateCaches();
  }

  function resetForNavigation() {
    const player = getPlayer();
    const video = getVideo(player);

    stopAcceleration(player, video, 'navigation');
    invalidateCaches();
    state.lastUrl = location.href;
    startLoop();
  }

  function watchUrlChanges() {
    document.addEventListener('yt-navigate-start', handleNavigateStart, false);
    document.addEventListener('yt-navigate-finish', resetForNavigation, false);

    window.setInterval(() => {
      if (state.lastUrl !== location.href) {
        resetForNavigation();
      }
    }, 1000);
  }

  window.addEventListener('beforeunload', () => {
    cleanupVideoListeners();
    if (state.timerId) {
      clearInterval(state.timerId);
    }
  });

  window.YTLiveMinimumLatency = Object.freeze({
    enableDebug() {
      window.localStorage?.setItem(DEBUG_STORAGE_KEY, '1');
      console.info('[YT Live Minimum Latency] Debug enabled. Reload the page if logs do not appear.');
    },
    disableDebug() {
      window.localStorage?.removeItem(DEBUG_STORAGE_KEY);
      console.info('[YT Live Minimum Latency] Debug disabled.');
    },
    getStatus() {
      return state.lastStatus;
    },
  });

  watchUrlChanges();
  startLoop();
})();

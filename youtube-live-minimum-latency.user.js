// ==UserScript==
// @name         YouTube Live Minimum Latency - Modified
// @description  YouTube Live の遅延を検出し、一時的に再生速度を上げてライブ位置へ追いつきやすくします。
// @namespace    https://github.com/scarecrowx913x/youtube-live-minimum-latency-mod
// @version      0.1.0-mod.13
// @author       Sigsign (original concept), modified by scarecrowx913x
// @license      MIT
// @match        https://www.youtube.com/*
// @run-at       document-idle
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
  const VIDEO_LISTENER_KEY = '__ytLmlVideoListenersAttached';
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
    bufferLowTickMs: 2000, // Increased polling when buffer is low
    maxManualLatencySec: 120,
    seekableFallbackMaxSec: 60,
    requiredBufferFloorSec: 1.0,
    debug: false,
    debugIntervalMs: 2000,

    thresholds: Object.freeze({
      ultraLow: Object.freeze({ latencySec: 2.0, bufferSec: 1.0 }),
      low: Object.freeze({ latencySec: 3.0, bufferSec: 2.0 }),
      normal: Object.freeze({ latencySec: 10.0, bufferSec: 2.0 }),
      premiere: Object.freeze({ latencySec: 10.0, bufferSec: 2.0 }),
      unknown: Object.freeze({ latencySec: 3.0, bufferSec: 2.0 }),
    }),

    // Cache TTL to reduce redundant DOM queries
    cacheTtlMs: 100,
  });

  const state = {
    timerId: null,
    currentTickMs: null,
    lastUrl: location.href,
    accelerating: false,
    lastDebugAt: 0,
    lastStatus: null,
    // Cache with timestamp
    playerCache: { value: null, timestamp: 0 },
    videoCache: { value: null, timestamp: 0 },
    // Event listener cleanup tracking
    eventListenersAttached: false,
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

  // Cached player getter to reduce DOM queries
  function getPlayer() {
    const now = Date.now();
    if (now - state.playerCache.timestamp < CONFIG.cacheTtlMs && state.playerCache.value) {
      return state.playerCache.value;
    }

    const player = document.querySelector('#movie_player');
    state.playerCache = { value: player, timestamp: now };
    return player;
  }

  // Cached video getter to reduce DOM queries
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

  function getAvailablePlaybackRates(player) {
    const rates = callPlayer(player, 'getAvailablePlaybackRates');
    return Array.isArray(rates) ? rates : [];
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

  function restartTimer(delayMs) {
    if (state.timerId) {
      clearInterval(state.timerId);
    }

    state.currentTickMs = delayMs;
    state.timerId = window.setInterval(tick, delayMs);
  }

  // NEW: Dynamic tick interval based on state
  function updateTickInterval(bufferSec) {
    let nextTickMs = CONFIG.idleTickMs;

    if (state.accelerating) {
      // When accelerating, poll more frequently
      nextTickMs = CONFIG.activeTickMs;
    } else if (Number.isFinite(bufferSec) && bufferSec < CONFIG.requiredBufferFloorSec * 2) {
      // When buffer is low (but not accelerating yet), poll more frequently
      nextTickMs = CONFIG.bufferLowTickMs;
    }

    if (state.currentTickMs !== nextTickMs) {
      restartTimer(nextTickMs);
    }
  }

  function startAcceleration(player, video, targetRate, reason) {
    if (state.accelerating && Math.abs(getActualPlaybackRate(video) - targetRate) <= 0.01) {
      return true; // Already at target rate
    }

    if (setPlaybackRate(player, video, targetRate)) {
      state.accelerating = true;
      updateTickInterval(0); // Will be updated on next tick
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
      updateTickInterval(null);
      log('normal speed', reason);
    } else {
      log('failed to return normal speed', reason);
    }
  }

  function handleBufferOnlyFallback(player, video, status) {
    const stopBufferSec = Math.max(CONFIG.requiredBufferFloorSec, status.threshold.bufferSec);

    if (!isPlainLivePlayback(player, video, getVideoStats(player))) {
      publishStatus({ ...status, reason: 'latency-unavailable' });
      updateTickInterval(status.bufferSec);
      return;
    }

    if (!state.accelerating) {
      if (status.bufferSec > status.threshold.bufferSec) {
        const changed = startAcceleration(player, video, CONFIG.accelerationStages[1].playbackRate, {
          bufferSec: status.bufferSec,
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

    const enforced = enforcePlaybackRate(player, video, CONFIG.accelerationStages[1].playbackRate);
    publishStatus({
      ...status,
      reason: enforced ? 'accelerating-continued-buffer-fallback' : 'accelerating-rate-enforce-failed-buffer-fallback',
      actualPlaybackRateAfter: getActualPlaybackRate(video),
      playerPlaybackRateAfter: getPlayerPlaybackRate(player),
    });
  }

  function ensureVideoListeners(video) {
    if (!video || video[VIDEO_LISTENER_KEY]) {
      return;
    }

    video[VIDEO_LISTENER_KEY] = true;
    video.addEventListener('playing', tick, false);
    video.addEventListener('play', tick, false);

    // Cleanup listeners on video end/pause to prevent memory leaks
    const cleanupHandler = () => {
      invalidateCaches();
      tick();
    };

    video.addEventListener('ended', cleanupHandler, false);
  }

  function tick() {
    const player = getPlayer();
    const video = getVideo(player);

    if (!player || !video) {
      publishStatus({ reason: 'waiting-player-or-video', hasPlayer: Boolean(player), hasVideo: Boolean(video) });
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

    const status = {
      reason: 'checking',
      accelerating: state.accelerating,
      latencySec,
      bufferSec,
      effectiveLatencySec,
      optimalRate,
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
      if (latencySec > threshold.latencySec && bufferSec >= threshold.bufferSec) {
        const changed = startAcceleration(player, video, optimalRate, {
          latencySec,
          bufferSec,
          effectiveLatencySec,
          optimalRate,
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

    // Adjust rate based on current latency while accelerating
    const currentTargetRate = getOptimalPlaybackRate(latencySec);
    const shouldStop = (
      latencySec <= threshold.latencySec ||
      bufferSec <= Math.max(CONFIG.requiredBufferFloorSec, threshold.bufferSec / 2)
    );

    if (shouldStop) {
      stopAcceleration(player, video, {
        latencySec,
        bufferSec,
        effectiveLatencySec,
        threshold,
      });
      publishStatus({
        ...status,
        reason: 'acceleration-stopped',
        actualPlaybackRateAfter: getActualPlaybackRate(video),
        playerPlaybackRateAfter: getPlayerPlaybackRate(player),
      });
      return;
    }

    // Adjust rate mid-acceleration if latency changed significantly
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

  function resetForNavigation() {
    const player = getPlayer();
    const video = getVideo(player);

    stopAcceleration(player, video, 'navigation');
    invalidateCaches();
    state.lastUrl = location.href;
    startLoop();
  }

  function watchUrlChanges() {
    document.addEventListener('yt-navigate-finish', resetForNavigation, false);

    window.setInterval(() => {
      if (state.lastUrl !== location.href) {
        resetForNavigation();
      }
    }, 1000);
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
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
// ==UserScript==
// @name         YouTube Live Minimum Latency - Modified
// @description  YouTube Live の遅延を検出し、一時的に再生速度を上げてライブ位置へ追いつきやすくします。
// @namespace    https://github.com/scarecrowx913x/youtube-live-minimum-latency-mod
// @version      0.1.0-mod.10
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
 */

(() => {
  'use strict';

  const DEBUG_STORAGE_KEY = 'yt_lml_debug';

  const CONFIG = Object.freeze({
    normalRate: 1.0,
    catchUpRate: 1.25,
    tickMs: 500,
    maxManualLatencySec: 120,
    seekableFallbackMaxSec: 60,
    requiredBufferFloorSec: 1.0,
    debug: false,
    debugIntervalMs: 2000,

    thresholds: Object.freeze({
      // Original-like thresholds: react quickly to small live latency drift.
      ultraLow: Object.freeze({ latencySec: 2.0, bufferSec: 1.0 }),
      low: Object.freeze({ latencySec: 3.0, bufferSec: 2.0 }),
      normal: Object.freeze({ latencySec: 10.0, bufferSec: 2.0 }),
      premiere: Object.freeze({ latencySec: 10.0, bufferSec: 2.0 }),
      // YouTube may not expose latency_class through getVideoStats().
      // If unknown, use the low-latency profile so optimized live streams still react quickly.
      unknown: Object.freeze({ latencySec: 3.0, bufferSec: 2.0 }),
    }),
  });

  const state = {
    timerId: null,
    lastUrl: location.href,
    accelerating: false,
    lastDebugAt: 0,
    lastStatus: null,
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
    return document.querySelector('#movie_player');
  }

  function getVideo(player = getPlayer()) {
    return (
      document.querySelector('video.html5-main-video') ||
      player?.querySelector?.('video') ||
      document.querySelector('video')
    );
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

    // Important: copy the threshold object before customizing it.
    // Do not mutate CONFIG.thresholds.
    const threshold = { ...base, key: thresholdKey };

    // YouTube Premiere / live premiere often behaves differently from ordinary live streams.
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
    // Prefer YouTube's own buffer range because it matches Stats for nerds more closely.
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

    // On long DVR/live streams this value can represent timeline distance rather than actual live latency.
    // Ignore very large fallback values so they do not trigger the manual-latency safety guard incorrectly.
    if (latencySec > CONFIG.seekableFallbackMaxSec) {
      return null;
    }

    return latencySec;
  }

  function getLiveLatencySec(player, video, stats) {
    // This captures a transport-ish latency that does not always include player buffer.
    const mediaReferenceLatency = getMediaReferenceLatencySec(player);
    if (Number.isFinite(mediaReferenceLatency)) {
      return mediaReferenceLatency;
    }

    return getSeekableLatencyFallbackSec(video, stats);
  }

  function getEffectiveLatencySec(latencySec, bufferSec) {
    // YouTube's Stats for nerds Live Latency is often close to media reference latency + buffer health.
    if (Number.isFinite(latencySec) && Number.isFinite(bufferSec)) {
      return latencySec + bufferSec;
    }

    if (Number.isFinite(latencySec)) {
      return latencySec;
    }

    return null;
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

    // Some pages wrap instance properties. Call the native setter too, just in case.
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      descriptor?.set?.call(video, rate);
    } catch (error) {
      log('native playbackRate setter failed', error);
    }

    return Math.abs(getActualPlaybackRate(video) - rate) <= 0.01;
  }

  function setPlaybackRate(player, video, rate) {
    // Some YouTube player methods return undefined even when the operation succeeds.
    // Do not trust the return value; verify the actual video playback rate.
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

  function startAcceleration(player, video, reason) {
    if (state.accelerating) {
      return enforcePlaybackRate(player, video, CONFIG.catchUpRate);
    }

    if (setPlaybackRate(player, video, CONFIG.catchUpRate)) {
      state.accelerating = true;
      log('accelerating', reason);
      return true;
    }

    log('failed to accelerate', reason);
    return false;
  }

  function stopAcceleration(player, video, reason) {
    if (!state.accelerating) {
      return;
    }

    if (setPlaybackRate(player, video, CONFIG.normalRate)) {
      state.accelerating = false;
      log('normal speed', reason);
    } else {
      log('failed to return normal speed', reason);
    }
  }

  function handleBufferOnlyFallback(player, video, status) {
    const stopBufferSec = Math.max(CONFIG.requiredBufferFloorSec, status.threshold.bufferSec);

    // Buffer-only mode is mainly for ordinary live streams where getMediaReferenceTime is unavailable.
    // Avoid applying it to DVR or live premiere, because it could override intentional seeking.
    if (!isPlainLivePlayback(player, video, getVideoStats(player))) {
      publishStatus({ ...status, reason: 'latency-unavailable' });
      return;
    }

    if (!state.accelerating) {
      if (status.bufferSec > status.threshold.bufferSec) {
        const changed = startAcceleration(player, video, {
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

    const enforced = enforcePlaybackRate(player, video, CONFIG.catchUpRate);
    publishStatus({
      ...status,
      reason: enforced ? 'accelerating-continued-buffer-fallback' : 'accelerating-rate-enforce-failed-buffer-fallback',
      actualPlaybackRateAfter: getActualPlaybackRate(video),
      playerPlaybackRateAfter: getPlayerPlaybackRate(player),
    });
  }

  function tick() {
    const player = getPlayer();
    const video = getVideo(player);

    if (!player || !video) {
      publishStatus({ reason: 'waiting-player-or-video', hasPlayer: Boolean(player), hasVideo: Boolean(video) });
      return;
    }

    const stats = getVideoStats(player);
    const videoData = getVideoData(player);
    const isLive = isLivePlayback(player, video, stats);

    if (!isLive) {
      stopAcceleration(player, video, 'not live');
      publishStatus({ reason: 'not-live', statsLive: stats?.live, videoDuration: video.duration, videoData });
      return;
    }

    if (video.paused || video.ended) {
      stopAcceleration(player, video, 'paused or ended');
      publishStatus({ reason: 'paused-or-ended', paused: video.paused, ended: video.ended });
      return;
    }

    const latencySec = getLiveLatencySec(player, video, stats);
    const bufferSec = getBufferedAheadSec(video, stats);
    const effectiveLatencySec = getEffectiveLatencySec(latencySec, bufferSec);
    const threshold = getThreshold(stats);
    const availableRates = getAvailablePlaybackRates(player);
    const actualPlaybackRate = getActualPlaybackRate(video);
    const playerPlaybackRate = getPlayerPlaybackRate(player);
    const status = {
      reason: 'checking',
      accelerating: state.accelerating,
      latencySec,
      bufferSec,
      effectiveLatencySec,
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
    };

    // If live latency cannot be obtained, use Buffer Health as a practical fallback.
    // This follows the same spirit as the original script's buffer-based behavior for long/current streams.
    if (effectiveLatencySec == null) {
      handleBufferOnlyFallback(player, video, status);
      return;
    }

    // If the viewer is intentionally far behind the live edge, avoid fighting them.
    // Same idea as the original: apply this safety guard mainly to DVR/premiere-like playback.
    if (stats?.live !== 'live' && effectiveLatencySec >= CONFIG.maxManualLatencySec) {
      stopAcceleration(player, video, 'manual latency assumed');
      publishStatus({ ...status, reason: 'manual-latency-assumed' });
      return;
    }

    // Avoid overriding a custom speed chosen by the viewer.
    if (!state.accelerating && Math.abs(actualPlaybackRate - CONFIG.normalRate) > 0.01) {
      publishStatus({ ...status, reason: 'manual-playback-rate-detected' });
      return;
    }

    if (!state.accelerating) {
      if (effectiveLatencySec > threshold.latencySec && bufferSec >= threshold.bufferSec) {
        const changed = startAcceleration(player, video, {
          latencySec,
          bufferSec,
          effectiveLatencySec,
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
      return;
    }

    if (
      effectiveLatencySec <= threshold.latencySec ||
      bufferSec <= Math.max(CONFIG.requiredBufferFloorSec, threshold.bufferSec / 2)
    ) {
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

    const enforced = enforcePlaybackRate(player, video, CONFIG.catchUpRate);
    publishStatus({
      ...status,
      reason: enforced ? 'accelerating-continued' : 'accelerating-rate-enforce-failed',
      actualPlaybackRateAfter: getActualPlaybackRate(video),
      playerPlaybackRateAfter: getPlayerPlaybackRate(player),
    });
  }

  function startLoop() {
    if (state.timerId) {
      clearInterval(state.timerId);
    }

    state.timerId = window.setInterval(tick, CONFIG.tickMs);
    tick();
  }

  function resetForNavigation() {
    const player = getPlayer();
    const video = getVideo(player);

    stopAcceleration(player, video, 'navigation');
    state.lastUrl = location.href;
    startLoop();
  }

  function watchUrlChanges() {
    document.addEventListener('yt-navigate-finish', resetForNavigation, false);

    // Fallback for YouTube SPA navigation changes that may not emit yt-navigate-finish.
    window.setInterval(() => {
      if (state.lastUrl !== location.href) {
        resetForNavigation();
      }
    }, 1000);
  }

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
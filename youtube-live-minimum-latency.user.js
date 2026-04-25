// ==UserScript==
// @name         YouTube Live Minimum Latency - Modified
// @description  YouTube Live の遅延を検出し、一時的に再生速度を上げてライブ位置へ追いつきやすくします。
// @namespace    https://github.com/scarecrowx913x/youtube-live-minimum-latency-mod
// @version      0.1.0-mod.5
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
    tickMs: 250,
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

  function isLivePlayback(player, video, stats) {
    const videoData = getVideoData(player);

    return Boolean(
      videoData?.isLive ||
      videoData?.isLiveContent ||
      stats?.live ||
      video?.duration === Infinity ||
      video?.seekable?.length
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
    // Original-like calculation: this matches YouTube's displayed Live Latency more reliably.
    const mediaReferenceLatency = getMediaReferenceLatencySec(player);
    if (Number.isFinite(mediaReferenceLatency)) {
      return mediaReferenceLatency;
    }

    return getSeekableLatencyFallbackSec(video, stats);
  }

  function getAvailablePlaybackRates(player) {
    const rates = callPlayer(player, 'getAvailablePlaybackRates');
    return Array.isArray(rates) ? rates : [];
  }

  function getPlaybackRate(player, video) {
    const playerRate = Number(callPlayer(player, 'getPlaybackRate'));
    if (Number.isFinite(playerRate) && playerRate > 0) {
      return playerRate;
    }

    return Number(video?.playbackRate) || CONFIG.normalRate;
  }

  function setPlaybackRate(player, video, rate) {
    const availableRates = getAvailablePlaybackRates(player);

    // YouTube may not list 1.25x for some live streams even when the video element accepts it.
    // Try the player API first only when it explicitly supports the target rate.
    if (availableRates.length === 0 || availableRates.includes(rate)) {
      const result = callPlayer(player, 'setPlaybackRate', rate);

      if (result !== undefined) {
        return true;
      }
    }

    if (video) {
      try {
        video.playbackRate = rate;
        return Math.abs(Number(video.playbackRate) - rate) <= 0.01;
      } catch (error) {
        log('video.playbackRate failed', error);
      }
    }

    return false;
  }

  function startAcceleration(player, video, reason) {
    if (state.accelerating) {
      return;
    }

    if (setPlaybackRate(player, video, CONFIG.catchUpRate)) {
      state.accelerating = true;
      log('accelerating', reason);
    } else {
      log('failed to accelerate', reason);
    }
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
    const threshold = getThreshold(stats);
    const availableRates = getAvailablePlaybackRates(player);
    const playbackRate = getPlaybackRate(player, video);
    const status = {
      reason: 'checking',
      accelerating: state.accelerating,
      latencySec,
      bufferSec,
      threshold,
      playbackRate,
      videoPlaybackRate: video.playbackRate,
      availableRates,
      statsLive: stats?.live,
      latencyClass: stats?.latency_class,
      currentTime: video.currentTime,
      statsCurrentTime: stats?.vct,
      mediaReferenceLatency: getMediaReferenceLatencySec(player),
      seekableEdge: getSeekableEdgeSec(video),
      seekableLatencyFallback: getSeekableLatencyFallbackSec(video, stats),
    };

    if (latencySec == null) {
      publishStatus({ ...status, reason: 'latency-unavailable' });
      return;
    }

    // If the viewer is intentionally far behind the live edge, avoid fighting them.
    // Same idea as the original: apply this safety guard mainly to DVR/premiere-like playback.
    if (stats?.live !== 'live' && latencySec >= CONFIG.maxManualLatencySec) {
      stopAcceleration(player, video, 'manual latency assumed');
      publishStatus({ ...status, reason: 'manual-latency-assumed' });
      return;
    }

    // Avoid overriding a custom speed chosen by the viewer.
    if (!state.accelerating && Math.abs(playbackRate - CONFIG.normalRate) > 0.01) {
      publishStatus({ ...status, reason: 'manual-playback-rate-detected' });
      return;
    }

    if (!state.accelerating) {
      if (latencySec > threshold.latencySec && bufferSec >= threshold.bufferSec) {
        startAcceleration(player, video, { latencySec, bufferSec, threshold });
        publishStatus({ ...status, reason: 'accelerating-started' });
        return;
      }

      publishStatus({ ...status, reason: 'below-threshold' });
      return;
    }

    if (
      latencySec <= threshold.latencySec ||
      bufferSec <= Math.max(CONFIG.requiredBufferFloorSec, threshold.bufferSec / 2)
    ) {
      stopAcceleration(player, video, { latencySec, bufferSec, threshold });
      publishStatus({ ...status, reason: 'acceleration-stopped' });
      return;
    }

    publishStatus({ ...status, reason: 'accelerating-continued' });
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
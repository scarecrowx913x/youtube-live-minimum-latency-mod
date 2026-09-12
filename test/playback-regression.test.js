const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const userscriptPath = path.join(__dirname, '..', 'youtube-live-minimum-latency.user.js');
const userscriptSource = fs.readFileSync(userscriptPath, 'utf8');

function createScenario({
  live = 'live',
  latencyClass = 'low',
  latencySec = 6,
  bufferSec = 6,
  availableRates = [1, 1.1, 1.15, 1.25, 1.5],
  currentTime = 10,
  playbackRate = 1,
} = {}) {
  const videoListeners = new Map();
  const timerDelays = [];
  let timerId = 0;

  const stats = {
    live,
    latency_class: latencyClass,
    vct: currentTime,
    vbu: `0-${currentTime + bufferSec}`,
  };

  const video = {
    duration: Infinity,
    paused: false,
    ended: false,
    currentTime,
    playbackRate,
    buffered: { length: 0 },
    seekable: Number.isFinite(latencySec)
      ? {
          length: 1,
          end() {
            return currentTime + latencySec;
          },
        }
      : { length: 0 },
    addEventListener(name, handler) {
      videoListeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (videoListeners.get(name) === handler) {
        videoListeners.delete(name);
      }
    },
    emit(name) {
      videoListeners.get(name)?.();
    },
  };

  const player = {
    getVideoStats() {
      return stats;
    },
    getVideoData() {
      return { isLive: true, isLiveContent: true };
    },
    getAvailablePlaybackRates() {
      return availableRates;
    },
    getPlaybackRate() {
      return video.playbackRate;
    },
    setPlaybackRate(rate) {
      video.playbackRate = rate;
    },
    getMediaReferenceTime() {
      return undefined;
    },
    querySelector(selector) {
      return selector === 'video' ? video : null;
    },
  };

  global.location = {
    href: 'https://www.youtube.com/watch?v=test',
    pathname: '/watch',
  };
  global.window = {
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    setInterval(_handler, delayMs) {
      timerId += 1;
      timerDelays.push(delayMs);
      return timerId;
    },
    addEventListener() {},
  };
  global.document = {
    querySelector(selector) {
      if (selector === '#movie_player') {
        return player;
      }
      if (selector === 'video.html5-main-video' || selector === 'video') {
        return video;
      }
      return null;
    },
    addEventListener() {},
  };
  global.clearInterval = () => {};
  global.HTMLMediaElement = class HTMLMediaElement {};

  vm.runInThisContext(userscriptSource, { filename: userscriptPath });

  return {
    player,
    video,
    stats,
    setBufferSec(nextBufferSec) {
      stats.vbu = `0-${currentTime + nextBufferSec}`;
    },
    getLastTimerDelay() {
      return timerDelays.at(-1);
    },
    getStatus() {
      return window.YTLiveMinimumLatency.getStatus();
    },
  };
}

test('buffer cap limits the selected acceleration rate', () => {
  const scenario = createScenario({
    latencySec: 12,
    bufferSec: 2.5,
    availableRates: [1, 1.1, 1.25],
  });

  const status = scenario.getStatus();
  assert.equal(status.optimalRate, 1.25);
  assert.equal(status.safeOptimalRate, 1.1);
  assert.equal(scenario.video.playbackRate, 1.1);
  assert.equal(status.reason, 'accelerating-started');
});

test('nearest available rate above the target is used only when it stays within the buffer cap', () => {
  const enoughBuffer = createScenario({
    latencySec: 6,
    bufferSec: 6,
    availableRates: [1, 1.25],
  });

  assert.equal(enoughBuffer.getStatus().safeOptimalRate, 1.25);
  assert.equal(enoughBuffer.video.playbackRate, 1.25);

  const cappedBuffer = createScenario({
    latencySec: 6,
    bufferSec: 4,
    availableRates: [1, 1.25],
  });

  assert.equal(cappedBuffer.getStatus().safeOptimalRate, 1);
  assert.equal(cappedBuffer.video.playbackRate, 1);
});

test('Premiere uses the safer 15 second latency threshold', () => {
  const scenario = createScenario({
    live: 'lp',
    latencySec: 12,
    bufferSec: 6,
  });

  const status = scenario.getStatus();
  assert.equal(status.threshold.key, 'premiere');
  assert.equal(status.threshold.latencySec, 15);
  assert.equal(status.reason, 'below-threshold');
  assert.equal(scenario.video.playbackRate, 1);
});

test('buffer-only fallback is disabled for DVR and Premiere', () => {
  for (const live of ['dvr', 'lp']) {
    const scenario = createScenario({
      live,
      latencySec: null,
      bufferSec: 8,
    });

    assert.equal(scenario.getStatus().reason, 'latency-unavailable-fallback-disabled');
    assert.equal(scenario.video.playbackRate, 1);
  }
});

test('buffer-only fallback remains available for plain live streams', () => {
  const scenario = createScenario({
    live: 'live',
    latencySec: null,
    bufferSec: 8,
    availableRates: [1, 1.15, 1.25],
  });

  assert.equal(scenario.getStatus().reason, 'accelerating-started-buffer-fallback');
  assert.equal(scenario.video.playbackRate, 1.15);
});

test('manual playback-rate changes cancel automatic acceleration without forcing 1.0x', () => {
  const scenario = createScenario({
    latencySec: 6,
    bufferSec: 6,
    availableRates: [1, 1.15, 1.25, 1.5],
  });

  assert.equal(scenario.video.playbackRate, 1.15);

  scenario.video.playbackRate = 1.5;
  scenario.video.emit('ratechange');

  const status = scenario.getStatus();
  assert.equal(status.reason, 'manual-playback-rate-preserved');
  assert.equal(scenario.video.playbackRate, 1.5);
});

test('starvation stops acceleration and starts cooldown', () => {
  const scenario = createScenario({
    latencySec: 6,
    bufferSec: 6,
    availableRates: [1, 1.15, 1.25],
  });

  assert.equal(scenario.video.playbackRate, 1.15);

  scenario.video.emit('waiting');
  assert.equal(scenario.getStatus().reason, 'starvation-cooldown-started');
  assert.equal(scenario.video.playbackRate, 1);

  scenario.video.emit('playing');
  assert.equal(scenario.getStatus().reason, 'acceleration-cooldown');
  assert.equal(scenario.video.playbackRate, 1);
});

test('low-buffer stop switches to the 2 second recovery polling interval', () => {
  const scenario = createScenario({
    latencySec: 6,
    bufferSec: 6,
    availableRates: [1, 1.15, 1.25],
  });

  assert.equal(scenario.video.playbackRate, 1.15);
  assert.equal(scenario.getLastTimerDelay(), 500);

  scenario.setBufferSec(1.5);
  scenario.video.emit('playing');

  assert.equal(scenario.getStatus().reason, 'acceleration-stopped');
  assert.equal(scenario.video.playbackRate, 1);
  assert.equal(scenario.getLastTimerDelay(), 2000);
});

test('buffer-only fallback low-buffer stop also keeps recovery polling fast', () => {
  const scenario = createScenario({
    live: 'live',
    latencySec: null,
    bufferSec: 8,
    availableRates: [1, 1.15, 1.25],
  });

  assert.equal(scenario.video.playbackRate, 1.15);
  assert.equal(scenario.getLastTimerDelay(), 500);

  scenario.setBufferSec(1.5);
  scenario.video.emit('playing');

  assert.equal(scenario.getStatus().reason, 'acceleration-stopped-buffer-fallback');
  assert.equal(scenario.video.playbackRate, 1);
  assert.equal(scenario.getLastTimerDelay(), 2000);
});

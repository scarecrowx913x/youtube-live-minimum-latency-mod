const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const userscriptPath = path.join(__dirname, '..', 'youtube-live-minimum-latency.user.js');
const userscriptSource = fs.readFileSync(userscriptPath, 'utf8');

function createVideo({ latencySec = 6, bufferSec = 6, paused = false } = {}) {
  const listeners = new Map();
  const video = {
    duration: Infinity,
    paused,
    ended: false,
    currentTime: 10,
    playbackRate: 1,
    isConnected: true,
    latencySec,
    bufferSec,
    buffered: { length: 0 },
    seekable: {
      length: 1,
      end() {
        return video.currentTime + video.latencySec;
      },
    },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) {
        listeners.delete(name);
      }
    },
    emit(name) {
      listeners.get(name)?.();
    },
    listenerCount() {
      return listeners.size;
    },
  };

  return video;
}

function createScenario({ latencySec = 6, bufferSec = 6, paused = false } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervals = new Map();
  let nextTimerId = 0;
  let currentVideo = createVideo({ latencySec, bufferSec, paused });

  const stats = {
    live: 'live',
    latency_class: 'low',
    get vct() {
      return currentVideo?.currentTime ?? 10;
    },
    get vbu() {
      const time = currentVideo?.currentTime ?? 10;
      const buffer = currentVideo?.bufferSec ?? 0;
      return `0-${time + buffer}`;
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
      return [1, 1.1, 1.15, 1.25];
    },
    getPlaybackRate() {
      return currentVideo?.playbackRate ?? 1;
    },
    setPlaybackRate(rate) {
      if (currentVideo) {
        currentVideo.playbackRate = rate;
      }
    },
    getMediaReferenceTime() {
      return undefined;
    },
    querySelector(selector) {
      return selector === 'video' ? currentVideo : null;
    },
  };

  global.location = {
    href: 'https://www.youtube.com/watch?v=first',
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
    setInterval(handler, delayMs) {
      nextTimerId += 1;
      intervals.set(nextTimerId, { handler, delayMs });
      return nextTimerId;
    },
    addEventListener(name, handler) {
      windowListeners.set(name, handler);
    },
  };
  global.document = {
    querySelector(selector) {
      if (selector === '#movie_player') {
        return player;
      }
      if (selector === 'video.html5-main-video' || selector === 'video') {
        return currentVideo;
      }
      return null;
    },
    addEventListener(name, handler) {
      documentListeners.set(name, handler);
    },
  };
  global.clearInterval = (timerId) => {
    intervals.delete(timerId);
  };
  global.HTMLMediaElement = class HTMLMediaElement {};

  vm.runInThisContext(userscriptSource, { filename: userscriptPath });

  return {
    get video() {
      return currentVideo;
    },
    getStatus() {
      return window.YTLiveMinimumLatency.getStatus();
    },
    dispatchDocument(name) {
      documentListeners.get(name)?.();
    },
    navigateTo(href, nextVideo) {
      location.href = href;
      location.pathname = '/watch';
      if (nextVideo !== undefined) {
        currentVideo = nextVideo;
      }
    },
    replaceVideo(nextVideo) {
      currentVideo = nextVideo;
    },
    runUrlWatcher() {
      const watcher = [...intervals.values()].find(({ delayMs }) => delayMs === 1000);
      assert.ok(watcher, '1 second URL/video watcher should exist');
      watcher.handler();
    },
  };
}

test('yt-navigate-start removes old listeners and clears cooldown before the next video', () => {
  const scenario = createScenario();
  const oldVideo = scenario.video;

  assert.equal(oldVideo.listenerCount(), 7);
  assert.equal(scenario.getStatus().reason, 'accelerating-started');

  oldVideo.emit('waiting');
  assert.equal(scenario.getStatus().reason, 'starvation-cooldown-started');

  scenario.dispatchDocument('yt-navigate-start');
  assert.equal(oldVideo.listenerCount(), 0);

  const nextVideo = createVideo({ latencySec: 6, bufferSec: 6 });
  scenario.navigateTo('https://www.youtube.com/watch?v=second', nextVideo);
  scenario.dispatchDocument('yt-navigate-finish');

  assert.equal(nextVideo.listenerCount(), 7);
  assert.equal(scenario.getStatus().reason, 'accelerating-started');
  assert.equal(nextVideo.playbackRate, 1.15);
});

test('URL polling fallback cleans old listeners when yt-navigate-start is missed', () => {
  const scenario = createScenario();
  const oldVideo = scenario.video;
  const nextVideo = createVideo({ latencySec: 6, bufferSec: 6 });

  assert.equal(oldVideo.listenerCount(), 7);
  oldVideo.isConnected = false;
  scenario.navigateTo('https://www.youtube.com/watch?v=fallback', nextVideo);
  scenario.runUrlWatcher();

  assert.equal(oldVideo.listenerCount(), 0);
  assert.equal(nextVideo.listenerCount(), 7);
  assert.equal(scenario.getStatus().reason, 'accelerating-started');
});

test('same-URL video replacement rebinds listeners through the 1 second watcher', () => {
  const scenario = createScenario({ latencySec: 2, bufferSec: 6 });
  const oldVideo = scenario.video;
  const nextVideo = createVideo({ latencySec: 6, bufferSec: 6, paused: true });

  assert.equal(scenario.getStatus().reason, 'below-threshold');
  oldVideo.isConnected = false;
  scenario.replaceVideo(nextVideo);
  scenario.runUrlWatcher();

  assert.equal(oldVideo.listenerCount(), 0);
  assert.equal(nextVideo.listenerCount(), 7);
  assert.equal(scenario.getStatus().reason, 'paused-or-ended');

  nextVideo.paused = false;
  nextVideo.emit('play');

  assert.equal(scenario.getStatus().reason, 'accelerating-started');
  assert.equal(nextVideo.playbackRate, 1.15);
});

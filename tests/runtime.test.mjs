import assert from 'node:assert/strict';
import { GuildQueue } from '../dist/queue/GuildQueue.js';
import { RetryManager } from '../dist/player/RetryManager.js';

const song = (id) => ({
  id,
  title: `Track ${id}`,
  sourceId: id,
  canonicalUrl: `https://example.com/${id}.opus`,
  webpageUrl: `https://example.com/${id}.opus`,
  author: 'test',
  duration: 60,
  thumbnail: '',
  requester: 'test',
  requesterId: 'test',
  isLive: false,
  source: 'direct',
});

const queue = new GuildQueue('test-channel', 80, 3);
assert.equal(queue.add(song('a')), true);
assert.equal(queue.add(song('a')), false, 'duplicate tracks must not be retained');
assert.deepEqual(queue.addMany([song('b'), song('c'), song('d')]).map((entry) => entry.id), ['b', 'c']);
assert.equal(queue.songs.length, 3, 'queue cap must bound retained metadata');

queue.loopMode = 'track';
assert.equal(queue.advance()?.id, 'a');
assert.equal(queue.current()?.id, 'a', 'track loop must replay only the completed track');
assert.equal(queue.history.length, 1);
queue.destroy();
assert.equal(queue.lifecycle, 'DESTROYED');

const retry = new RetryManager();
const transient = new Error('socket timed out');
assert.equal(retry.next('track', transient).retry, true);
assert.equal(retry.next('track', transient).retry, true);
assert.equal(retry.next('track', transient).retry, true);
assert.equal(retry.next('track', transient).retry, false, 'retry attempts must be bounded');
retry.reset();
assert.equal(retry.next('track', new Error('age-restricted content')).retry, false, 'non-recoverable tracks must be skipped');

const forbidden = new RetryManager().next('403-track', new Error('HTTP 403 Forbidden'));
assert.equal(forbidden.retry, true, '403 must resolve a fresh stream with bounded retry');
assert.equal(forbidden.refreshStream, true, '403 must not retry the same direct URL');
assert.equal(new RetryManager().next('gone', new Error('HTTP 410 Gone')).retry, false, 'deleted media must skip');
assert.equal(new RetryManager().next('server', new Error('HTTP 503 Service Unavailable')).retry, true, 'source 5xx must retry');
const ffmpegRetry = new RetryManager();
assert.equal(ffmpegRetry.next('ffmpeg', new Error('FFmpeg exited 1')).retry, true);
assert.equal(ffmpegRetry.next('ffmpeg', new Error('FFmpeg exited 1')).retry, true);
assert.equal(ffmpegRetry.next('ffmpeg', new Error('FFmpeg exited 1')).retry, false, 'FFmpeg restarts must be bounded');

// Volume normalization and event verification
const volQueue = new GuildQueue('vol-channel', 1.0);
let capturedVol = 0;
volQueue.on('volumeChange', (v) => { capturedVol = v; });
assert.equal(volQueue.setVolume(50), 0.5, '50% volume should normalize to 0.5');
assert.equal(capturedVol, 0.5, 'volumeChange event should emit normalized volume');
assert.equal(volQueue.formatVolumeDisplay(), '50%');
assert.equal(volQueue.setVolume(250), 2.0, 'exceeding max volume should clamp to 2.0');
assert.equal(volQueue.setVolume(-10), 0.01, 'negative volume should clamp to 0.01');
volQueue.destroy();

// Previous track history restoration tests
const prevQueue = new GuildQueue('prev-channel', 1.0);
prevQueue.add(song('prev-1'));
prevQueue.add(song('prev-2'));
const s1 = prevQueue.advance();
assert.equal(s1?.id, 'prev-1');
assert.equal(prevQueue.history.length, 1);
assert.equal(prevQueue.history[0].id, 'prev-1');
assert.equal(prevQueue.current()?.id, 'prev-2');

// Call previous when playing track 2: track 1 is restored to position 1 and skipped to
let skipCalled = false;
prevQueue.attachController({
  destroy: () => {},
  skip: () => { skipCalled = true; prevQueue.advance(); },
  stop: () => {},
});
const restored = prevQueue.previous();
assert.equal(restored?.id, 'prev-1');
assert.equal(prevQueue.history.length, 0);

// Test previous when queue has finished / empty
const emptyPrevQueue = new GuildQueue('empty-prev', 1.0);
emptyPrevQueue.add(song('first'));
emptyPrevQueue.advance(); // moved to history, queue empty
assert.equal(emptyPrevQueue.songs.length, 0);
assert.equal(emptyPrevQueue.history.length, 1);
const replayed = emptyPrevQueue.previous();
assert.equal(replayed?.id, 'first');
assert.equal(emptyPrevQueue.songs.length, 1);
assert.equal(emptyPrevQueue.current()?.id, 'first');
emptyPrevQueue.destroy();

// Stop method tests
let stopCalled = false;
const stopQueue = new GuildQueue('stop-channel', 1.0);
stopQueue.attachController({
  destroy: () => {},
  stop: () => { stopCalled = true; },
});
stopQueue.stop();
assert.equal(stopCalled, true, 'queue.stop must delegate to attached controller.stop');
stopQueue.destroy();

console.log('Runtime queue and retry checks passed');

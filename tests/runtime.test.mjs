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

console.log('Runtime queue and retry checks passed');

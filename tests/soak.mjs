import process from 'node:process';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { GuildQueue } from '../dist/queue/GuildQueue.js';
import { getStream } from '../dist/player/stream.js';

const iterations = 400;
const leakThresholds = {
  heapDeltaMB: 80,
  handleGrowth: 25,
  listenerGrowth: 20,
};

let unhandledRejections = 0;
let unhandledExceptions = 0;
let leakDetected = false;
let leakReason = '';
let leakContext = '';

const sampleHandles = () => {
  const handles = process._getActiveHandles?.() ?? [];
  const summary = handles.reduce((acc, handle) => {
    const name = handle?.constructor?.name ?? 'Unknown';
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});

  return {
    count: handles.length,
    summary,
    timers: handles.filter((h) => h?.constructor?.name === 'Timeout' || h?.constructor?.name === 'Immediate').length,
    childProcesses: handles.filter((h) => h?.constructor?.name === 'ChildProcess').length,
    streams: handles.filter((h) => ['Socket', 'TTYWrap', 'Pipe'].includes(h?.constructor?.name)).length,
  };
};

const createFakeConnection = () => ({
  state: { status: VoiceConnectionStatus.Ready },
  on: function () {},
  off: function () {},
  destroy: function () { this.state.status = VoiceConnectionStatus.Destroyed; },
  subscribe: function () {},
});

const makeSong = (id) => ({
  id: `soak-${id}`,
  title: `Soak Track ${id}`,
  url: `https://example.com/track/${id}`,
  duration: 180 + (id % 10),
  thumbnail: 'https://example.com/thumb.jpg',
  requester: 'soak-tester',
  requesterId: 'soak-id',
  isLive: false,
  author: 'Soak',
  views: 1000 + id,
  source: 'direct',
});

process.on('unhandledRejection', () => {
  unhandledRejections += 1;
});

process.on('uncaughtException', () => {
  unhandledExceptions += 1;
});

const baselineMem = process.memoryUsage().heapUsed / 1024 / 1024;
const baselineHandles = sampleHandles();
let maxHeapMB = baselineMem;
let maxHandles = baselineHandles.count;
let maxListeners = 0;

console.log('START METRICS');
console.log(JSON.stringify({
  baselineHeapMB: baselineMem.toFixed(2),
  baselineHandles: baselineHandles,
  iterations,
}, null, 2));

for (let i = 0; i < iterations; i += 1) {
  const queue = new GuildQueue(`channel_${i}`, 80);
  const conn = createFakeConnection();
  queue.setConnection(conn);
  queue.add(makeSong(i));
  queue.addMany([makeSong(i + 1), makeSong(i + 2)]);
  queue.setPlaying(true);
  queue.skip();
  queue.setPlaying(false);
  queue.advance();
  queue.shuffleQueue();
  queue.clearQueue();
  queue.destroy();

  try {
    await getStream('https://example.invalid/stream', false);
  } catch {
    // expected failure
  }

  try {
    await getStream('not-a-valid-url', false);
  } catch {
    // expected failure
  }

  const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
  const handles = sampleHandles();
  const listenerScore = (queue.player?.listenerCount?.('stateChange') ?? 0) + (queue.listenerCount?.('trackEnd') ?? 0);

  maxHeapMB = Math.max(maxHeapMB, memMB);
  maxHandles = Math.max(maxHandles, handles.count);
  maxListeners = Math.max(maxListeners, listenerScore);

  if (memMB - baselineMem > leakThresholds.heapDeltaMB || handles.count - baselineHandles.count > leakThresholds.handleGrowth || listenerScore > leakThresholds.listenerGrowth) {
    leakDetected = true;
    leakReason = `Observed growth beyond thresholds at iteration ${i}`;
    leakContext = JSON.stringify({ memMB, handles, listenerScore, baselineMem, baselineHandles });
    break;
  }

  if (i % 50 === 0) {
    console.log(`progress:${i}/${iterations} heap=${memMB.toFixed(2)}MB handles=${handles.count} listeners=${listenerScore}`);
  }
}

const endMem = process.memoryUsage().heapUsed / 1024 / 1024;
const endHandles = sampleHandles();

console.log('END METRICS');
console.log(JSON.stringify({
  endHeapMB: endMem.toFixed(2),
  memoryDifferenceMB: (endMem - baselineMem).toFixed(2),
  peakHeapMB: maxHeapMB.toFixed(2),
  endHandles,
  peakHandles: maxHandles,
  peakListeners: maxListeners,
  unhandledRejections,
  unhandledExceptions,
  leakDetected,
  leakReason,
  leakContext,
}, null, 2));

if (leakDetected) {
  process.exitCode = 1;
}

import assert from 'node:assert/strict';
import { validateExpiry, validateSource, validateStream } from '../dist/sources/stream-resolver.js';
import { shouldRecoverYouTubeStream } from '../dist/sources/ytdlp-wrapper.js';
import { extractInnerTubeAudioStream } from '../dist/sources/youtube-innertube.js';
import fs from 'node:fs';

const tiktok = {
  source: 'tiktok', sourceId: '123', canonicalUrl: 'https://www.tiktok.com/@creator/video/123', webpageUrl: 'https://www.tiktok.com/@creator/video/123',
  title: 'Original TikTok', author: 'creator', duration: 10, thumbnail: '', isLive: false,
};
validateSource(tiktok);

const signedAudioExpiry = Math.floor(Date.now() / 1000) + 300;
const directAudioUrl = 'https://rr1---sn.googlevideo.com/videoplayback?expire=' + signedAudioExpiry;
const innertubeAudio = extractInnerTubeAudioStream({
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [
    { mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: directAudioUrl, bitrate: 128000 },
    { mimeType: 'audio/webm; codecs="opus"', url: directAudioUrl, bitrate: 96000 },
    { mimeType: 'audio/webm; codecs="opus"', url: 'https://evil.example/audio', bitrate: 256000 },
  ] },
}, { name: 'ANDROID', userAgent: 'Gecko-test' });
assert.equal(innertubeAudio?.url, directAudioUrl);
assert.equal(innertubeAudio?.clientName, 'ANDROID');
assert.equal(innertubeAudio?.expiresAt, signedAudioExpiry * 1000);
assert.equal(innertubeAudio?.headers['User-Agent'], 'Gecko-test');
assert.equal(extractInnerTubeAudioStream({
  playabilityStatus: { status: 'LOGIN_REQUIRED' },
  streamingData: { adaptiveFormats: [{ mimeType: 'audio/webm', url: directAudioUrl }] },
}, { name: 'ANDROID', userAgent: 'Gecko-test' }), null);
assert.equal(extractInnerTubeAudioStream({
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [{ mimeType: 'audio/webm', signatureCipher: 's=opaque' }] },
}, { name: 'ANDROID', userAgent: 'Gecko-test' }), null);

assert.equal(shouldRecoverYouTubeStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'TIMEOUT'), true);
assert.equal(shouldRecoverYouTubeStream('https://youtu.be/dQw4w9WgXcQ', 'BOT_DETECTION'), true);
assert.equal(shouldRecoverYouTubeStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'VIDEO_UNAVAILABLE'), false);
assert.equal(shouldRecoverYouTubeStream('https://example.com/watch?v=dQw4w9WgXcQ', 'TIMEOUT'), false);
assert.equal(shouldRecoverYouTubeStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'TIMEOUT', true), false);

const streamResolverSource = fs.readFileSync(new URL('../src/sources/stream-resolver.ts', import.meta.url), 'utf8');
assert.match(streamResolverSource, /const forcePipe = target\.source === "tiktok";/, 'forceRefresh should re-resolve YouTube instead of forcing the same pipe extractor');

assert.throws(() => validateStream(tiktok, 'youtube', 'https://r1.googlevideo.com/videoplayback'), /Cross-source stream blocked/);
assert.throws(() => validateStream(tiktok, 'tiktok', 'https://r1.googlevideo.com/videoplayback'), /Cross-source media host blocked/);
assert.throws(() => validateExpiry(Date.now() - 1), /expired/);

const spotify = { ...tiktok, source: 'spotify', sourceId: 'sp123', canonicalUrl: 'https://open.spotify.com/track/sp123', webpageUrl: 'https://open.spotify.com/track/sp123', playbackSource: 'youtube', playbackUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', playbackSourceId: 'dQw4w9WgXcQ', mappingVerified: true };
validateSource(spotify);
validateStream(spotify, 'youtube', 'https://r1.googlevideo.com/videoplayback');
assert.throws(() => validateStream({ ...spotify, mappingVerified: false }, 'youtube'), /Unverified Spotify/);
const tiktokSource = fs.readFileSync(new URL('../src/sources/tiktok.ts', import.meta.url), 'utf8');
const managerSource = fs.readFileSync(new URL('../src/sources/resolver.ts', import.meta.url), 'utf8');
assert.ok(!tiktokSource.includes('searchProvider'), 'TikTok resolver must not search another provider');
assert.ok(!managerSource.includes('const searchQuery'), 'Related playback must not have a global title-search fallback');
console.log('Source identity, expiry, and cross-source policy checks passed');

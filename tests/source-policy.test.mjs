import assert from 'node:assert/strict';
import { validateExpiry, validateSource, validateStream } from '../dist/sources/stream-resolver.js';
import fs from 'node:fs';

const tiktok = {
  source: 'tiktok', sourceId: '123', canonicalUrl: 'https://www.tiktok.com/@creator/video/123', webpageUrl: 'https://www.tiktok.com/@creator/video/123',
  title: 'Original TikTok', author: 'creator', duration: 10, thumbnail: '', isLive: false,
};
validateSource(tiktok);
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

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const fs = require('node:fs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filePath = path.join(root, 'src', 'queue', 'GuildQueue.ts');
const source = fs.readFileSync(filePath, 'utf8');

assert.ok(source.includes('public audioFilter'), 'GuildQueue should expose audioFilter state');
assert.ok(source.includes('public shuffleQueue'), 'GuildQueue should expose shuffleQueue');
assert.ok(source.includes('public clearQueue'), 'GuildQueue should expose clearQueue');
assert.ok(source.includes('public destroy'), 'GuildQueue should expose destroy');

const playerFile = path.join(root, 'src', 'events', 'voiceStateUpdate.ts');
const voiceSource = fs.readFileSync(playerFile, 'utf8');
assert.ok(voiceSource.includes('RECONNECT_ATTEMPTS'), 'Voice handler should include reconnect logic');
assert.ok(voiceSource.includes('emptyVoiceTimeout'), 'Voice handler should use empty voice timeout');

const joinFile = path.join(root, 'src', 'commands', 'join.ts');
const joinSource = fs.readFileSync(joinFile, 'utf8');
assert.ok(!joinSource.includes('currentConnection.on('), 'Join command should not attach ad-hoc connection listeners');

const playFile = path.join(root, 'src', 'commands', 'play.ts');
const playSource = fs.readFileSync(playFile, 'utf8');
assert.ok(!playSource.includes('currentConnection.on('), 'Play command should not attach ad-hoc connection listeners');
assert.ok(playSource.indexOf('await interaction.deferReply') < playSource.indexOf('activeCommandLocks.has'), '/play must acknowledge before acquiring its per-guild lock');

const playerPlayFile = path.join(root, 'src', 'player', 'play.ts');
const playbackSource = fs.readFileSync(playerPlayFile, 'utf8');
assert.ok(playbackSource.includes('GuildPlaybackController'), 'Playback entry point should delegate to the per-guild controller');
assert.ok(!playbackSource.includes('playbackStates'), 'Playback state must not be held in a global guild map');

const controllerFile = path.join(root, 'src', 'player', 'GuildPlaybackController.ts');
const controllerSource = fs.readFileSync(controllerFile, 'utf8');
assert.ok(controllerSource.includes('VOICE_RECONNECT_ATTEMPTS'), 'Controller should own bounded voice reconnection');
assert.ok(controllerSource.includes('RetryManager'), 'Controller should use bounded retry policy');
assert.ok(controllerSource.includes('destroy(): void'), 'Controller must expose deterministic teardown');
assert.ok(controllerSource.includes('volumeChange'), 'Controller should listen to volume changes');
const sessionFile = path.join(root, 'src', 'player', 'VoiceSessionManager.ts');
const sessionSource = fs.readFileSync(sessionFile, 'utf8');
assert.ok(sessionSource.indexOf('queue.destroy();') < sessionSource.indexOf('destroy-session-orphan-connection'), '/stop must tear down the queue before an orphaned voice connection');

const pipelineFile = path.join(root, 'src', 'player', 'AudioPipeline.ts');
const pipelineSource = fs.readFileSync(pipelineFile, 'utf8');
assert.ok(pipelineSource.includes('StreamType.OggOpus'), 'Pipeline should emit Discord-ready Ogg/Opus');
assert.ok(pipelineSource.includes('ffmpeg-static'), 'Pipeline should use the bundled FFmpeg binary');
assert.ok(pipelineSource.includes('stallTimeoutMs'), 'Pipeline should detect a stalled FFmpeg/audio stream');

const resolverFile = path.join(root, 'src', 'sources', 'stream-resolver.ts');
const resolverSource = fs.readFileSync(resolverFile, 'utf8');
assert.ok(!resolverSource.includes('method: "HEAD"'), 'Direct media must not be probed with HEAD before playback');
assert.ok(resolverSource.includes('forceRefresh'), 'Recovery must be able to force a new stream URL');
assert.ok(resolverSource.includes('target.source === "tiktok"'), 'TikTok playback must keep session-bound media downloads inside yt-dlp');

console.log('Core runtime checks passed');

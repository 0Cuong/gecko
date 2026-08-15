# Gecko Music Subsystem Architecture

This document describes the simplified, deterministic music architecture of Gecko.
When modifying music code, AI agents should read **only** this document and the relevant files in `src/player/`, `src/queue/`, and `src/sources/`.

---

## 1. Single Responsibilities

```
src/
├── player/
│   ├── GuildPlaybackController.ts  # Playback authority per guild (ONE per guild)
│   ├── AudioPipeline.ts            # FFmpeg process & low-latency Ogg/Opus stream lifecycle
│   ├── VoiceSessionManager.ts      # Discord voice channel join & session management
│   ├── RetryManager.ts             # Playback error classification & retry backoff strategy
│   ├── stream.ts                   # Audio stream resolver (direct HTTP / yt-dlp / TikTok / JIT Spotify)
│   ├── filter.ts                   # FFmpeg filter builder (bassboost, nightcore, etc.)
│   └── play.ts                     # Slash command entry point for starting playback
│
├── queue/
│   ├── GuildQueue.ts               # Guild queue state & @discordjs/voice AudioPlayer wrapper
│   └── types.ts                    # Song type, LoopMode, PlayerLifecycleState, buildSongFromTrack()
│
└── sources/
    ├── resolver.ts                 # ResolverManager entry point (URL/query -> TrackMetadata)
    ├── youtube.ts                  # YouTube resolver
    ├── youtube-innertube.ts        # YouTube Innertube resolver
    ├── spotify.ts                  # Spotify resolver & metadata provider
    ├── soundcloud.ts               # SoundCloud resolver
    ├── tiktok.ts                   # TikTok resolver
    ├── generic.ts                  # Generic direct URL resolver
    └── ytdlp-wrapper.ts            # yt-dlp execution wrapper
```

---

## 2. Core Invariants

1. **ONE PLAYER PER GUILD**: Each guild has exactly one `GuildQueue` in `client.queues` and one `GuildPlaybackController` attached to it.
2. **ONE PLAYBACK AUTHORITY**: `GuildPlaybackController` is the sole owner of FFmpeg processes, audio stream buffers, and voice connection lifecycle for a guild. Commands NEVER manipulate audio streams directly.
3. **ONE NORMALIZED MODEL**: All tracks resolve to `TrackMetadata` (from resolvers) and normalize to `Song` in the queue (`queue/types.ts`). Player core only works with `Song`.
4. **NO SPOTIFY COUPLING IN PLAYER**: `GuildPlaybackController` does not import Spotify resolvers. JIT lazy track resolution happens inside `stream.ts`.
5. **CLEAN RESOURCE RELEASE**: `GuildPlaybackController.destroy()` and `GuildQueue.destroy()` kill FFmpeg child processes, unregister event listeners, clear timers, and release voice connections idempotently.

---

## 3. Data Flow

### /play Command Flow
```
User -> Slash Command (/play)
     -> VoiceSessionManager.ensureQueueAndConnection(guild, channel)
     -> resolve(query) -> TrackMetadata[]
     -> buildSongFromTrack() -> Song[]
     -> queue.addMany(songs)
     -> play(client, guildId)
     -> controller.ensurePlayback()
```

### Playback Lifecycle
```
ensurePlayback()
  -> getStream(song) (resolves JIT lazy track if needed)
  -> AudioPipeline(stream) (spawns FFmpeg, pipes Ogg/Opus)
  -> player.play(pipeline.resource)
  -> AudioPlayerStatus.Playing
  -> (track ends) -> completeCurrentTrack() -> queue.advance() -> ensurePlayback()
```

### Skip Flow
```
/skip -> queue.skip() -> controller.skip() -> pipeline.close() -> queue.advance() -> ensurePlayback()
```

### Stop Flow
```
/stop -> VoiceSessionManager.destroySession(guildId) -> queue.destroy() & controller.destroy()
```

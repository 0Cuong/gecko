# Gecko Discord Music Bot

A Discord music bot built with Node.js, TypeScript, and `discord.js`. It streams audio into Discord voice channels with support for queues, playback controls, and multiple stream sources.

## Requirements

- Node.js >= 24.0.0
- Package manager: `pnpm` (recommended), `npm`, or `yarn`
- FFmpeg (provided via `ffmpeg-static` or a system installation set in `FFMPEG_PATH`)
- Python and C++ build tools (required for compiling native modules such as `@discordjs/opus` or `sodium-native`)

## Stack

- **Runtime & Language:** Node.js, TypeScript
- **Discord API & Voice:** `discord.js`, `@discordjs/voice`
- **Audio Processing:** `prism-media`, `ffmpeg-static`, `@discordjs/opus`
- **Source Extractors:** `@distube/ytdl-core`, `play-dl`
- **Build System:** `@swc/core`, `typescript`

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/0Cuong/gecko.git
cd gecko
pnpm install
```

Build the TypeScript source:

```bash
pnpm run typecheck
pnpm run build
```

Start the bot:

```bash
# Production
pnpm start

# Development
pnpm dev
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable              | Required | Default | Description                                                  |
| --------------------- | -------- | ------- | ------------------------------------------------------------ |
| `BOT_TOKEN`           | Yes      | —       | Discord bot authorization token                              |
| `DEV_GUILD_ID`        | No       | —       | Guild ID for instant command registration during development |
| `DEFAULT_VOLUME`      | No       | `100`   | Initial volume level (1–200)                                 |
| `IDLE_TIMEOUT`        | No       | `300`   | Inactivity timeout in seconds before leaving voice channel   |
| `EMPTY_VOICE_TIMEOUT` | No       | `180`   | Timeout in seconds before leaving an empty voice channel     |
| `MAX_QUEUE_SIZE`      | No       | `500`   | Maximum number of tracks in queue                            |
| `MAX_PLAYLIST_SIZE`   | No       | `100`   | Maximum tracks imported per playlist                         |
| `PORT`                | No       | `3000`  | Port for health check and metrics server                     |
| `CONTROL_CENTER_KEY`   | Production | —     | Required Control Center authentication secret                |
| `CONTROL_CENTER_ORIGIN`| No       | —       | Optional exact browser origin allowed to call the Control Center API |
| `BIND_HOST`            | Production | `127.0.0.1` | HTTP bind address; use a trusted private interface behind a proxy |
| `SPOTIFY_CLIENT_ID`   | No       | —       | Spotify API client ID for Spotify link support               |
| `SPOTIFY_CLIENT_SECRET`| No     | —       | Spotify API client secret for Spotify link support           |

## Commands

| Command              | Description                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| `/play <query>`      | Play audio from song name, YouTube, SoundCloud, Spotify, TikTok, or direct stream URL |
| `/skip`              | Skip the current track                                                                |
| `/stop`              | Stop playback, clear queue, and leave voice channel                                   |
| `/pause`             | Pause playback                                                                        |
| `/resume`            | Resume playback                                                                       |
| `/queue`             | Display the current queue                                                             |
| `/nowplaying`        | Display information about the currently playing track                                 |
| `/volume <level>`    | Adjust volume (1–200%)                                                                |
| `/loop <mode>`       | Set loop mode (`track`, `queue`, or `off`)                                            |
| `/shuffle`           | Shuffle tracks in the queue                                                           |
| `/search <query>`    | Search for tracks and select from a selection menu                                    |
| `/join`              | Connect bot to the current voice channel                                              |
| `/leave`             | Disconnect bot from the voice channel                                                 |
| `/clear`             | Remove all queued tracks                                                              |
| `/remove <position>` | Remove a track at a specific position in the queue                                    |
| `/move <from> <to>`  | Move a track to a different position in the queue                                     |
| `/previous`          | Play the previously played track                                                      |
| `/autoplay`          | Toggle automatic recommendation mode                                                  |
| `/system`            | Display runtime metrics and system status                                             |
| `/help`              | Display available commands and usage information                                      |

## Security

Do not commit the `.env` file or expose your `BOT_TOKEN`. Keep authorization credentials secure.

## License

Refer to the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for licensing details and third-party dependency notices.

## Author

Original author: [0Cuong](https://github.com/0Cuong)

# Discord Player Distube Based Extractor

A extractor for discord-player that uses the DisTube utilities under the hood.
Only supports YouTube for now. May add support for other platforms in the future.

---

## Install

```bash
npm i discord-player-distube
```

## Supported Platforms

- YouTube (search, videos, playlists and mixes)
- Still under development - Youtube mixes are NOT working ATM.

## Usage

```ts
import { Player } from "discord-player";
import { DisTubeExtractor } from "discord-player-distube-extractor";

const player = new Player(client);

player.extractors.register(DisTubeExtractor, {
  // optional
  youtube: {
    // cookies: <ytdl-core Cookie[]>,
    // ytdlOptions: { highWaterMark: 1 << 25 }
  }
});
```

Then use discord-player as usual (`player.play(...)`, etc.).

## Options

- `youtube.cookies?: ytdl.Cookie[]`
  - Optional cookies for YouTube (e.g., to unlock age-restricted videos). These are cookie objects as accepted by `@distube/ytdl-core`.
- `youtube.ytdlOptions?: ytdl.getInfoOptions`
  - Extra options forwarded to `@distube/ytdl-core` for info/stream extraction (e.g. headers, highWaterMark).


## Dependencies

- `discord-player`
- `@distube/ytdl-core`
- `@distube/ytsr`
- `@distube/ytpl`
- `undici` (transport used by `@distube/ytdl-core`)

## Limitations

- YouTube only. (No Spotify/SoundCloud/etc.)
- No youtubei/TV OAuth integration
- Members-only, paid, or DRM-protected content is not supported.

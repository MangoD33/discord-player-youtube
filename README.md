# Discord Player YouTube

YouTube extractor for discord-player with layered provider fallbacks and optional TV OAuth.

---

## Install

```bash
npm i discord-player-youtube
```

Optional peers for richer fallback behavior:

```bash
npm i @distube/ytsr @distube/ytpl @distube/yt-dlp
```

If `@distube/ytdl-core` cannot select a direct stream, a local `yt-dlp` binary (if available) is used to fetch a best-audio URL. Set `YTDLP_PATH` to override the binary location.

## Supported

- YouTube search, videos, playlists, mixes
- Bridging helper to locate a playable YouTube stream

## Quick Start

```ts
import { Player } from "discord-player";
import { YouTubeExtractor } from "discord-player-youtube";

const player = new Player(client);

await player.extractors.register(YouTubeExtractor, {
  // Optional: override extractor registration priority in discord-player
  // Higher value runs first when multiple extractors match
  priority: 2,
  // Enable (optional) TV OAuth sign-in for youtubei.js
  // Semicolon-delimited key=value string: "access_token=...; expiry_date=...; refresh_token=...; ..."
  authentication: process.env.MY_YT_AUTH_STRING,

  // youtubei.js cookie for Innertube (string, tough-cookie jar, array, or map)
  cookie: process.env.MY_YT_COOKIE,
  // Optionally attempt to generate a PoToken for Innertube
  // (uses bgutils-js + jsdom when possible)
  generateWithPoToken: false,
  // Optional stream behavior
  streamOptions: {
    // Choose Innertube client used for stream URL selection
    // Examples: 'ANDROID' (default), 'WEB', 'TV', 'ANDROID_MUSIC'
    useClient: 'ANDROID',
    // If provided, extractor returns a buffered Readable stream instead of URL
    // Useful to increase Node stream buffer for unstable networks
    highWaterMark: 1 << 25 // ~33MB
  }

  // ytdl-core options/cookies for info + stream extraction
  youtube: {
    // Cookie header string or array of @distube/ytdl-core Cookie objects
    cookies: "SID=...; HSID=...; ...",
    // Forwarded to @distube/ytdl-core
    ytdlOptions: {}
  },
});
```

Then use discord-player as usual (`player.play(...)`, etc.). This extractor also registers protocols `ytsearch://`, `yt://`, and `youtube://` for convenience when applicable.

## Options

- priority: number to override extractor registration priority (higher runs first).
- authentication: semicolon-delimited token string for TV OAuth sign-in.
- cookie: cookie for youtubei.js (string, tough-cookie jar, array of cookie-like objects, or name-value map).
- youtube.cookies: string | ytdl.Cookie[] used by `@distube/ytdl-core`.
- youtube.ytdlOptions: forwarded to `@distube/ytdl-core` (headers, requestOptions, etc.).
- generateWithPoToken: boolean to try generating a PoToken for the Innertube client.
- streamOptions.useClient: preferred Innertube client tag for streaming (e.g. 'ANDROID', 'WEB', 'TV', 'ANDROID_MUSIC').
- streamOptions.highWaterMark: if set (> 0), extractor will fetch and return a Readable stream piped through a PassThrough
  with the specified highWaterMark, instead of returning a URL string.

## Provider Priority (advanced)

Resolution and streaming use multiple providers with sensible defaults:

- search: ytjs -> ytsr
- playlist: ytjs -> ytpl
- mix (RD): ytjs (no fallbacks)
- video: ytjs -> ytdl
- stream: ytjs -> ytdl -> ytdlp

Note: Mixes (RD playlists) are resolved exclusively via youtubei.js (ytjs). The ytpl fallback is disabled for mixes.

You can tweak priorities at runtime if needed:

```ts
import { setPriorities } from "discord-player-youtube/dist/internal/utils.js";

// Prefer ytsr for search and ytdlp for stream
setPriorities({
  search: ["ytsr", "ytjs"],
  stream: ["ytdlp", "ytdl", "ytjs"],
});
```

## Bridging Helper

Quickly find a likely-official YouTube result and a playable stream URL:

```ts
import { YouTubeExtractor } from "discord-player-youtube";

const result = await YouTubeExtractor.bridge("track name artist", {
  youtube: { /* optional ytdl cookies/options */ }
});

if (result) {
  // result.url = canonical YouTube URL
  // result.streamUrl = resolved best-audio stream
  // result.item = normalized metadata
}
```

## TV OAuth (optional but recommended)

Providing `authentication` enables TV OAuth with youtubei.js and can improve reliability for age/region-restricted content, mixes, and stream selection.

- Pass the full semicolon-separated token string. It's parsed and used with the TV Embedded client. If sign-in fails, a warning is logged and the client continues unsigned.
- Set `YT_CACHE_DIR` to persist the youtubei.js cache directory.
- Optionally set `generateWithPoToken: true` to attempt generating a PoToken for the Innertube client.

## Environment Variables

- `YT_CACHE_DIR`: Optional directory path for youtubei.js persistent cache.
- `YTDLP_PATH`: Optional path to a local yt-dlp binary for streaming fallback.

## Dependencies

- discord-player
- youtubei.js (Innertube)
- @distube/ytdl-core
- undici (HTTP for ytdl-core)
- @distube/ytsr (optional peer; search fallback)
- @distube/ytpl (optional peer; playlist fallback)
- yt-dlp (optional peer; binary used if present)

## Limitations

- Members-only/paid/DRM content is not supported.

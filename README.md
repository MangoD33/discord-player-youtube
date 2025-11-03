# discord-player-youtube

YouTube extractor for Discord Player v7. Temporary extractor while we wait for [discord-player-youtubei](https://github.com/retrouser955/discord-player-youtubei) rewrite to complete.

## Installation

```bash
npm install discord-player-youtube
```

Requirements:

- Node.js 18+ (built‑in `fetch`, WHATWG streams, and ESM)

## Quick Start

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { Player } from "discord-player";
import { YoutubeExtractor } from "discord-player-youtube";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const player = new Player(client);

await player.extractors.register(YoutubeExtractor, {
  cookie: process.env.YOUTUBE_COOKIE, // Recommended
  filterAutoplayTracks: true, // enabled by default
  disableYTJSLog: true, // silence youtubei.js logs
});

// use player as usual
```

## Configuration - Optional

This extractor works out of the box, but for best stability, you should provide a YouTube cookie.

| Option                 | Type    | Default              | Description                                                                                                                 |
| ---------------------- | ------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cookie`               | string  | `env.YOUTUBE_COOKIE` | YouTube cookie string. Improves stability and may help with age‑restricted tracks.                                          |
| `filterAutoplayTracks` | boolean | `true`               | Autoplay recommendations exclude tracks already present in the queue history. Set to `false` to allow repeats from history. |

#### Getting your YouTube cookie

> For a step-by-step guide on how to obtain a valid YouTube cookie from your browser session, follow the [official youtubei.js documentation](https://ytjs.dev/guide/authentication.html#cookies).

##### Notes and tips:

- Use a throwaway YouTube account. Do not share your personal cookies.
- If you rotate or remove the cookie, restart your bot process to pick up changes.

### Advanced Configuration

- `innertubeConfigRaw` (optional): Pass-through to Innertube.create() (type: [InnerTubeConfig](https://ytjs.dev/api/type-aliases/SessionOptions.html)).
- `sabrPlaybackOptions` (optional): Type-safe pass-through to SABR playback configuration (type: [SabrPlaybackOptions](https://ytjs.dev/googlevideo/api/exports/sabr-stream/interfaces/SabrPlaybackOptions.html)).
  > Default: medium audio quality, audio-only, prefer H264.

## License

Licensed under CC‑BY‑4.0. See `LICENSE` for details.

## Acknowledgements

Big shout-out to [iTsMaaT](https://github.com/iTsMaaT), [Retro](https://github.com/retrouser955) and [brrrbot](https://github.com/brrrbot) — this extractor would not have been possible without their valuable contribution.

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

await player.extractors.register(YoutubeExtractor);

// use player as usual
```

## Configuration

This extractor works out of the box, but for best stability, you should provide a YouTube cookie.

- `YOUTUBE_COOKIE` (optional, recommended): A full YouTube cookie string from your browser session. This improves request stability and may help with age‑restricted or region‑locked content.

#### Getting your YouTube cookie

For a step-by-step guide on how to obtain a valid YouTube cookie from your browser session, follow the [official youtubei.js documentation](https://ytjs.dev/guide/authentication.html#cookies).

#### Where to set it:

1. In an `.env` file (dotenv is automatically loaded):

```
YOUTUBE_COOKIE=VISITOR_INFO1_LIVE=...; PREF=...; YSC=...; __Secure-...=...;
```

2. Or as an environment variable in your process manager (PM2, Docker, systemd, etc.).

#### Notes and tips:

- Use a throwaway YouTube account. Do not share personal cookies.
- If you rotate or remove the cookie, restart your bot process to pick up changes.

## License

Licensed under CC‑BY‑4.0. See `LICENSE` for details.

## Acknowledgements

Big shout-out to [iTsMaaT](https://github.com/iTsMaaT), [Retro](https://github.com/retrouser955) and [brrrbot](https://github.com/brrrbot) — this code is a mix derived from their work and guidance.

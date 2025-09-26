// Smoke tests using discord-player with proper extractor registration only.
// Verifies search, playlist, mix, video, and stream via the public API.

import { Client } from 'discord.js';
import { Player, QueryType } from 'discord-player';
import { YouTubeExtractor } from '../dist/index.js';

// Basic unicode support detection with sensible fallbacks
function isUnicodeSupported() {
  if (process.platform !== 'win32') return true;
  return (
    Boolean(process.env.WT_SESSION) || // Windows Terminal
    Boolean(process.env.TERM_PROGRAM) ||
    process.env.ConEmuTask === '{cmd::Cmder}'
  );
}

const symbols = isUnicodeSupported()
  ? { ok: '\u2705', fail: '\u274C', arrow: '\u2192' }
  : { ok: 'V', fail: 'X', arrow: '->' };

async function runAll() {
  const client = new Client({ intents: [] });
  const player = new Player(client);

  await player.extractors.register(YouTubeExtractor, {
    youtube: {},
  });

  const ctx = { requestedBy: { id: 'smoke' } };
  const results = [];
  async function record(name, fn) {
    try {
      const out = await fn();
      results.push({ name, ok: true, out });
    } catch (e) {
      results.push({ name, ok: false, err: e });
    }
  }

  const playlistUrl =
    'https://www.youtube.com/playlist?list=PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj';
  const mixUrl =
    'https://www.youtube.com/watch?v=uxpDa-c-4Mc&list=RDEMEPsGcPqqzpBxP-gtt4OYKg';
  const videoUrl = 'https://youtu.be/dQw4w9WgXcQ';
  const searchQuery = 'rick astley never gonna give you up';

  // search via discord-player
  await record('search', async () => {
    const res = await player.search(searchQuery, {
      requestedBy: ctx.requestedBy,
      searchEngine: QueryType.YOUTUBE_SEARCH,
    });
    if (!res || res.tracks.length === 0) throw new Error('no results');
    return { count: res.tracks.length, first: res.tracks[0]?.title ?? null };
  });

  // playlist via discord-player
  await record('playlist', async () => {
    const res = await player.search(playlistUrl, {
      requestedBy: ctx.requestedBy,
      searchEngine: QueryType.YOUTUBE_PLAYLIST,
    });
    if (!res.playlist) throw new Error('no playlist meta');
    if (res.tracks.length === 0) throw new Error('no items');
    return { title: res.playlist.title, count: res.tracks.length };
  });

  // mix (RD) via discord-player
  await record('mix', async () => {
    const res = await player.search(mixUrl, {
      requestedBy: ctx.requestedBy,
      searchEngine: QueryType.AUTO,
    });
    if (res.playlist) {
      if (res.tracks.length < 1) throw new Error('expected playlist items');
      return { title: res.playlist.title, count: res.tracks.length };
    }
    if (res.tracks.length !== 1)
      throw new Error('expected single item fallback');
    return res.tracks[0].title;
  });

  // video via discord-player
  let videoTrackTitle = null;
  let videoTrack = null;
  await record('video', async () => {
    const res = await player.search(videoUrl, {
      requestedBy: ctx.requestedBy,
      searchEngine: QueryType.YOUTUBE_VIDEO,
    });
    if (res.playlist) throw new Error('unexpected playlist');
    if (res.tracks.length !== 1) throw new Error('expected single item');
    videoTrack = res.tracks[0];
    videoTrackTitle = videoTrack.title;
    return videoTrackTitle;
  });

  // stream using the extractor instance attached to the Track
  await record('stream', async () => {
    const track = videoTrack;
    if (!track) throw new Error('missing video track');
    const extractor = track?.extractor;
    if (!extractor || typeof extractor.stream !== 'function') {
      throw new Error('extractor not available on track');
    }
    const data = await extractor.stream(track);
    if (typeof data === 'string') {
      if (!/^https?:\/\//.test(data)) throw new Error('invalid url');
      return data.slice(0, 60) + '...';
    }
    // If it returned a Readable stream, just indicate success
    return 'readable-stream';
  });

  console.log(`\n=== smoke (dp + extractor) ===`);
  for (const r of results) {
    const extra =
      typeof r.out === 'string'
        ? ` ${symbols.arrow} ${r.out}`
        : r.out
        ? ` ${symbols.arrow} ${JSON.stringify(r.out)}`
        : '';
    if (r.ok) {
      console.log(`${symbols.ok} ${r.name}${extra}`);
    } else {
      console.log(
        `${symbols.fail} ${r.name} ${symbols.arrow} ${r.err?.message || r.err}`
      );
    }
  }

  // Cleanup
  player.extractors.unregister(YouTubeExtractor.identifier);
  client.removeAllListeners();
}

try {
  await runAll();
} catch (e) {
  console.error(e);
  process.exit(1);
}

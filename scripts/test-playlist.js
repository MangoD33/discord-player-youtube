import { Client } from 'discord.js';
import { Player } from 'discord-player';
import * as yt from '../dist/internal/youtube.js';
import { buildPlaylistMeta, buildTrack } from '../dist/internal/utils.js';

const url = 'https://www.youtube.com/playlist?list=PLqEwRgo0ltuWESZdQkK2TLTH-pGQpW0A0';

// Minimal Player to satisfy Track/Playlist constructors (no login required)
const client = new Client({ intents: [] });
const player = new Player(client);

try {
  const resolved = await yt.resolve(url);
  const playlist = resolved.playlist ? buildPlaylistMeta(player, resolved.playlist) : null;
  const ctx = { requestedBy: null };
  const tracks = resolved.items.map(i => buildTrack(player, i, ctx, playlist, null));
  if (playlist) playlist.tracks = tracks;

  console.log('Playlist object:', {
    id: playlist?.id,
    title: playlist?.title,
    url: playlist?.url,
    trackCount: playlist?.tracks.length,
  });
  console.log('First 3 tracks:', playlist?.tracks.slice(0, 3).map(t => ({ title: t.title, url: t.url })));
} catch (e) {
  console.error('Test error:', e);
  process.exit(1);
}


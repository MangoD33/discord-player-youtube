import { Client } from 'discord.js';
import { Player, QueryType } from 'discord-player';
import { DisTubeExtractor } from '../dist/index.js';

const url = 'https://www.youtube.com/playlist?list=PLqEwRgo0ltuWESZdQkK2TLTH-pGQpW0A0';

const client = new Client({ intents: [] });
const player = new Player(client);

// Register our extractor
player.extractors.register(DisTubeExtractor, {});

try {
  const res = await player.search(url, { searchEngine: QueryType.YOUTUBE_PLAYLIST });
  console.log('SearchResult playlist?', !!res.playlist);
  console.log('Playlist title:', res.playlist?.title);
  console.log('Tracks length:', res.tracks.length);
  console.log('First 3:', res.tracks.slice(0,3).map(t => ({ title: t.title, url: t.url })));
} catch (e) {
  console.error('Extractor test error:', e);
  process.exit(1);
}


import * as yt from '../dist/internal/youtube.js';

const url = 'https://www.youtube.com/playlist?list=PLqEwRgo0ltuWESZdQkK2TLTH-pGQpW0A0';

try {
  const r = await yt.resolve(url);
  console.log('Playlist meta:', r.playlist);
  console.log('Items length:', r.items.length);
  console.log('First 3:', r.items.slice(0,3).map(i => ({ title: i.title, url: i.url })));
} catch (e) {
  console.error('Error:', e);
  process.exit(1);
}


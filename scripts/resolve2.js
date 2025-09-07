import * as yt from '../dist/internal/youtube.js';

const url = 'https://www.youtube.com/playlist?list=PLqEwRgo0ltuWESZdQkK2TLTH-pGQpW0A0';
(async () => {
  const r = await yt.resolve(url);
  console.log(r.items.map(i => ({ title: i.title, dur: i.durationMS })).slice(0, 5));
})();


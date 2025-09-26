import ytpl from "@distube/ytpl";
import ytdl from "./ytdl.js";
import { toSecond, type NormalizedItem, type NormalizedResult } from "./utils.js";

function extractPlaylistId(href: string): string | null {
  try { const u = new URL(href); const list = u.searchParams.get("list"); if (list && list.trim().length > 0) return list.trim(); } catch { }
  return null;
}

export async function relatedFromBasic(url: string): Promise<NormalizedResult> {
  const basic = await ytdl.getBasicInfo(url, ytdl.options());
  const related = (basic.related_videos?.filter((r: any) => r.id) ?? [])
    .filter((r: any) => { const len = Number((r as any).length_seconds) || 0; return len === 0 || len >= 60; });
  const items: NormalizedItem[] = related.map((r: any) => ({
    source: "youtube",
    url: `https://youtu.be/${r.id}`,
    title: r.title ?? "Unknown",
    author: typeof r.author === "string" ? r.author : r.author?.name || (r.author as any)?.user || "Unknown",
    durationMS: (r.isLive ? 0 : toSecond((r as any).length_seconds)) * 1000,
    thumbnail: r.thumbnails?.sort((a: any, b: any) => b.width - a.width)?.[0]?.url,
    isLive: Boolean(r.isLive),
    raw: r,
  }));
  return { playlist: null, items };
}

export async function ytplResolve(url: string): Promise<NormalizedResult | null> {
  ytdl.ensure();

  const playlistId = extractPlaylistId(url) || (ytpl.validateID(url) ? url : null);
  if (!playlistId) return null;
  // Do not handle mixes (RD...); mixes should be resolved via ytjs
  if (/^RD/i.test(String(playlistId))) return null;

  try {
    const info = await ytpl(playlistId, { limit: Infinity, requestOptions: { headers: ytdl.headers() } });

    const items: NormalizedItem[] = info.items.map(i => ({
      source: "youtube",
      url: (i as any).shortUrl || i.url,
      title: i.title ?? "Unknown",
      author: i.author?.name ?? "Unknown",
      durationMS: toSecond(i.duration) * 1000,
      thumbnail: i.thumbnail,
      isLive: Boolean((i as any).isLive),
      playlistId: info.id,
      playlistTitle: info.title,
      raw: i,
    }));

    const playlistThumb = info.items.find(x => !!x.thumbnail)?.thumbnail;
    return { playlist: { id: info.id, title: info.title, url: info.url, thumbnail: playlistThumb }, items };
  } catch (e) {
    return null;
  }
}

import ytsr from "@distube/ytsr";
import ytdl from "./ytdl.js";
import { msFromDurationLike, parseNumber, type NormalizedItem, type NormalizedResult } from "./utils.js";

export async function ytsrSearch(
  query: string,
  options: { type?: "video" | "playlist"; limit?: number; safeSearch?: boolean } = {}
): Promise<NormalizedResult | null> {
  try {
    ytdl.ensure();
    const limit = Math.min(options.limit ?? 20, 20);
    const { items } = await ytsr(query, {
      type: options.type ?? "video",
      limit,
      safeSearch: options.safeSearch ?? false,
      requestOptions: { headers: ytdl.headers() },
    });

    type Scored = { item: NormalizedItem; score: number };
    const scored: Scored[] = [];
    for (const i of items) {
      if (i.type !== "video") continue;
      const v = i as ytsr.Video;
      const url = v.url ?? `https://youtu.be/${v.id}`;
      const title = v.name ?? "Unknown";
      const author = v.author?.name ?? "Unknown";
      const durationMS = msFromDurationLike(v.duration ?? 0);

      const isShortForm = url.includes("/shorts/") || (durationMS > 0 && durationMS < 60_000);

      const tLower = (title || "").toLowerCase();
      let score = 0;
      if (isShortForm) score -= 1;

      const qLower = (query || "").toLowerCase();
      const qTokens = new Set(qLower.split(/[^a-z0-9]+/).filter(Boolean));
      const titleTokens = new Set(tLower.split(/[^a-z0-9]+/).filter(Boolean));
      const negativeWords = [
        "live",
        "cover",
        "remix",
        "mix",
        "sped",
        "slowed",
        "nightcore",
        "8d",
        "edit",
        "mashup",
        "reverb",
        "lyrics",
        "lyric",
        "beatbox",
      ];
      const hasUnwantedNegative = negativeWords.some(w => titleTokens.has(w) && !qTokens.has(w));
      if (hasUnwantedNegative) score -= 1;

      const views = parseNumber((v as any).views);

      const item: NormalizedItem = {
        source: "youtube",
        url,
        title,
        author,
        durationMS,
        thumbnail: v.thumbnail,
        isLive: Boolean(v.isLive),
        views,
        raw: v,
      };
      scored.push({ item, score });
    }

    scored.sort((a: any, b: any) => b.score - a.score);
    const outItems = scored.map(s => s.item).slice(0, limit);
    return { playlist: null, items: outItems };
  } catch {
    return null;
  }
}


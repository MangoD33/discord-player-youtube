import { Playlist, Track, Util } from "discord-player";
import type { ExtractorSearchContext } from "discord-player";
import type { Innertube } from "youtubei.js/agnostic";
import { YT } from "youtubei.js/agnostic";

export type NormalizedItem = {
  source: string;
  url: string;
  title: string;
  author: string;
  durationMS: number;
  thumbnail?: string;
  isLive?: boolean;
  views?: number;
  raw?: any;
};

export function buildTrack(
  player: import("discord-player").Player,
  item: NormalizedItem,
  ctx: ExtractorSearchContext,
  playlist?: Playlist | null,
  extractor?: any | null
): Track {
  const durationTC = Util.buildTimeCode(Util.parseMS(item.durationMS || 0));
  const t = new Track(player, {
    title: item.title,
    description: `${item.title} by ${item.author}`,
    author: item.author,
    url: item.url,
    thumbnail: item.thumbnail,
    duration: durationTC,
    views: item.views ?? 0,
    requestedBy: (ctx?.requestedBy as any) ?? undefined,
    source: item.source as any,
    queryType: "youtubeVideo",
    metadata: { source: item.raw, bridge: (item as any)?.raw?.bridge ?? null },
    requestMetadata: async () => ({
      source: item.raw,
      bridge: (item as any)?.raw?.bridge ?? null,
    }),
    playlist: playlist ?? undefined,
  });
  if (extractor) (t as any).extractor = extractor;
  return t;
}

export function buildPlaylistMeta(
  player: import("discord-player").Player,
  meta: { id: string; title?: string; url?: string; thumbnail?: string }
): Playlist {
  return new Playlist(player, {
    title: meta.title ?? "unknown",
    description: "",
    thumbnail: meta.thumbnail ?? "",
    type: "playlist",
    source: "youtube",
    author: { name: "unknown", url: "" },
    tracks: [],
    id: meta.id,
    url: meta.url ?? "",
    rawPlaylist: meta,
  });
}

export function msFromDurationLike(input: any): number {
  try {
    if (typeof input === "number") return Math.max(0, input);
    const s = String(input ?? "").trim();
    if (!s) return 0;
    // Accept formats like HH:MM:SS or MM:SS
    const parts = s.split(":").map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return 0;
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      seconds = parts[0];
    }
    return Math.max(0, seconds * 1000);
  } catch {
    return 0;
  }
}

export function textFromRuns(obj: any): string | undefined {
  try {
    const runs = obj?.runs as any[] | undefined;
    if (runs?.length) return String(runs.map((r) => r.text).join(""));
    const simple = obj?.simpleText;
    if (simple) return String(simple);
  } catch {}
  return undefined;
}

export function extractVideoId(input: any): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const s = input.trim();

  const idPattern = /^[a-zA-Z0-9_-]{11}$/;
  if (idPattern.test(s)) return s;

  try {
    const url = new URL(s);
    const host = url.hostname.toLowerCase();

    // youtu.be/<id>
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length > 0 && idPattern.test(segs[0])) return segs[0];
    }

    // *.youtube.com/watch?v=<id>
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && idPattern.test(v)) return v;

      // Support /shorts/<id>, /embed/<id>, /v/<id>
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length >= 2) {
        const [first, second] = segs;
        if (
          (first === "shorts" || first === "embed" || first === "v") &&
          idPattern.test(second)
        ) {
          return second;
        }
      }
    }
  } catch {}

  const m = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];

  const parts = s.split(/[/?&#]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (idPattern.test(parts[i])) return parts[i];
  }

  return null;
}

export async function searchYoutubeByQueryName(
  innertube: Innertube,
  query: string
): Promise<YT.Search | undefined> {
  let search: YT.Search | undefined;
  try {
    search = await innertube.search(query);
    if (!search || search.results.length === 0) return undefined;
  } catch (error) {
    console.error(
      `[Youtube Extractor Error] Error while searching by name: ${error}`
    );
  }
  return search;
}

export function checkIsUrl(query: string): boolean {
  let isUrl: boolean;
  try {
    new URL(query);
    isUrl = true;
  } catch (error) {
    isUrl = false;
  }
  return (
    isUrl ||
    new RegExp("^https?://(www\\.)?(youtube\\.com|youtu\\.be)/", "i").test(
      query
    )
  );
}

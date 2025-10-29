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

function toStringSafe(t: any): string | undefined {
  try {
    if (typeof t === "string") return t;
    if (typeof t?.toString === "function") return String(t.toString());
    if (typeof t?.text === "string") return t.text;
  } catch {}
  return undefined;
}

function normalizeCandidateToItem(candidate: any): NormalizedItem | null {
  try {
    if (!candidate || typeof candidate !== "object") return null;

    // If it's already a normalized item, return as-is
    if (
      typeof candidate.url === "string" &&
      typeof candidate.title === "string" &&
      typeof candidate.author === "string" &&
      typeof candidate.durationMS === "number"
    ) {
      return candidate as NormalizedItem;
    }

    const video_id =
      candidate?.video_id || candidate?.id || candidate?.content_id || null;
    if (typeof video_id !== "string") return null;

    const title =
      candidate?.title?.text ||
      toStringSafe(candidate?.metadata?.title) ||
      candidate?.title ||
      "UNKNOWN TITLE";
    const author = candidate?.author?.name || "UNKNOWN AUTHOR";
    const thumb =
      candidate?.best_thumbnail?.url ||
      candidate?.thumbnails?.[0]?.url ||
      candidate?.thumbnail?.[0]?.url ||
      candidate?.content_image?.image?.[0]?.url ||
      undefined;

    // Duration: prefer numeric seconds; try to parse common timecode text or a11y label as fallback
    let seconds = Number(candidate?.duration?.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const maybeTexts: (string | undefined)[] = [
        toStringSafe(candidate?.duration?.text),
        toStringSafe(candidate?.renderer_context?.accessibility_context?.label),
      ];
      for (const s of maybeTexts) {
        if (!s) continue;
        const m = s.match(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/);
        if (m) {
          const parts = m[0].split(":").map((n) => parseInt(n, 10));
          if (parts.length === 3)
            seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
          break;
        }
        // Fallback: parse english duration phrases like "1 hour, 5 minutes, 29 seconds" - TEMPORARY UNTIL WE FIND A ALTERNATIVE - NOT ACCURATE DURATION
        if (!Number.isFinite(seconds) || seconds <= 0) {
          const parsed = parseEnglishDurationLabel(s);
          if (parsed > 0) {
            seconds = parsed;
            break;
          }
        }
      }
      if (!Number.isFinite(seconds)) seconds = 0;
    }

    return {
      source: "youtube",
      url: `https://www.youtube.com/watch?v=${video_id}`,
      title: String(title),
      author: String(author),
      durationMS: Math.max(0, Math.floor(seconds) * 1000),
      thumbnail: typeof thumb === "string" ? thumb : undefined,
      isLive: !!candidate?.is_live,
      raw: candidate,
    };
  } catch {
    return null;
  }
}

function parseEnglishDurationLabel(input: string): number {
  try {
    const s = String(input || "").toLowerCase();
    let total = 0;
    const re =
      /(\d+)\s*(hour|hours|hr|hrs|minute|minutes|min|mins|second|seconds|sec|secs)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(s))) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      if (!Number.isFinite(value)) continue;
      if (unit.startsWith("hour") || unit.startsWith("hr"))
        total += value * 3600;
      else if (unit.startsWith("min")) total += value * 60;
      else if (unit.startsWith("sec")) total += value;
    }
    return total;
  } catch {
    return 0;
  }
}

export function buildTrack(
  player: import("discord-player").Player,
  item: NormalizedItem | any,
  ctx: ExtractorSearchContext,
  playlist?: Playlist | null,
  extractor?: any | null
): Track {
  const normalized = normalizeCandidateToItem(item) ?? (item as NormalizedItem);
  const durationTC = Util.buildTimeCode(
    Util.parseMS(normalized.durationMS || 0)
  );
  const t = new Track(player, {
    title: normalized.title,
    description: `${normalized.title} by ${normalized.author}`,
    author: normalized.author,
    url: normalized.url,
    thumbnail: normalized.thumbnail,
    duration: durationTC,
    views: normalized.views ?? 0,
    requestedBy: (ctx?.requestedBy as any) ?? undefined,
    source: (normalized.source as any) ?? ("youtube" as any),
    queryType: "youtubeVideo",
    metadata: {
      source: (normalized as any).raw ?? item,
      bridge: (normalized as any)?.raw?.bridge ?? null,
    },
    requestMetadata: async () => ({
      source: (normalized as any).raw ?? item,
      bridge: (normalized as any)?.raw?.bridge ?? null,
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

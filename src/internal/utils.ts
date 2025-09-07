import type { ExtractorSearchContext } from "discord-player";
import { Track, Playlist, Util, QueryType } from "discord-player";
import * as youtube from "./youtube.js";

/* =========================
 * Shared Types
 * ========================= */
export type NormalizedItem = {
    source: "youtube";
    url: string;
    title: string;
    author: string;
    durationMS: number;
    thumbnail?: string;
    isLive?: boolean;
    playlistId?: string;
    playlistTitle?: string;
    views?: number;
    likes?: number;
    raw?: any;
};

export type NormalizedResult = {
    playlist: { id: string; title?: string; url?: string; thumbnail?: string } | null;
    items: NormalizedItem[];
};

/* =========================
 * Duration and number helpers
 * ========================= */
export function msFromDurationLike(secOrStr?: number | string): number {
    if (!secOrStr) return 0;
    if (typeof secOrStr === "number") return Math.max(0, Math.floor(secOrStr * 1000));
    const parts = secOrStr.split(":").reverse();
    let seconds = 0;
    for (let i = 0; i < parts.length; i++) {
        seconds += Number(parts[i].replace(/[^\d.]+/g, "")) * Math.pow(60, i);
    }
    return seconds * 1000;
}

export const clone = <T>(obj: T): T => {
    const result: any = Array.isArray(obj) ? [] : {};
    for (const key in obj as any) {
        const v = (obj as any)[key];
        result[key] = v && typeof v === "object" ? clone(v) : v;
    }
    return result as T;
};

export function toSecond(input: any): number {
    if (!input) return 0;
    if (typeof input !== "string") return Number(input) || 0;
    if (input.includes(":")) {
        const time = input.split(":").reverse();
        let seconds = 0;
        for (let i = 0; i < 3; i++) if (time[i]) seconds += Number(time[i].replace(/[^\d.]+/g, "")) * Math.pow(60, i);
        if (time.length > 3) seconds += Number(time[3].replace(/[^\d.]+/g, "")) * 24 * 60 * 60;
        return seconds;
    }
    return Number(input.replace(/[^\d.]+/g, "")) || 0;
}

export function parseNumber(input: any): number {
    if (typeof input === "string") return Number(input.replace(/[^\d.]+/g, "")) || 0;
    return Number(input) || 0;
}

/* =========================
 * Dispatchers
 * ========================= */
export async function dispatchResolve(url: string): Promise<NormalizedResult> {
    // Pure YouTube extractor: resolve everything via YouTube (falls back to search)
    return youtube.resolve(url);
}

export async function dispatchRelated(track: Track): Promise<NormalizedResult> {
    return youtube.related(track.url);
}

export async function dispatchStream(track: Track): Promise<string> {
    return youtube.streamUrl(track.url);
}

/* =========================
 * Builders (Track/Playlist)
 * ========================= */
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
        requestedBy: ctx?.requestedBy as any,
        source: item.source,
        queryType: "youtubeVideo",
        metadata: {
            source: item.raw,
            bridge: (item as any).raw?.bridge ?? null
        },
        requestMetadata: async () => ({
            source: item.raw,
            bridge: (item as any).raw?.bridge ?? null
        }),
        playlist: playlist ?? undefined
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

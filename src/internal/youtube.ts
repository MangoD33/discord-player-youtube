import ytdl from "./ytdl.js";
import {
    toSecond,
    parseNumber,
    clone,
    toCookieArray,
    type NormalizedItem,
    type NormalizedResult,
} from "./utils.js";

import { ytsrSearch } from "./ytsr.js";
import { ytplResolve } from "./ytpl.js";
import { ytjsResolveMix } from "./ytjs.js";
import { extractPlaylistIdFromUrl } from "./utils.js";

export type YouTubeOptions = {
    // Accept a cookie header string (e.g. "SID=...; HSID=...;") or an array of Cookie objects
    cookies?: string | import("./ytdl.js").Cookie[];
    ytdlOptions?: import("./ytdl.js").getInfoOptions;
};

let _cookies: import("./ytdl.js").Cookie[] | undefined;

export function configure(opts: YouTubeOptions = {}) {
    _cookies = toCookieArray(opts.cookies);
    ytdl.init({ cookies: _cookies, ytdlOptions: opts.ytdlOptions ? clone(opts.ytdlOptions) : {} });
}

function ensureAgent() {
    ytdl.ensure();
}

function mergedYtdlOptions(): import("./ytdl.js").getInfoOptions {
    return ytdl.options();
}

export async function search(
    query: string,
    options: { type?: "video" | "playlist"; limit?: number; safeSearch?: boolean } = {},
): Promise<NormalizedResult> {
    ensureAgent();
    const res = await ytsrSearch(query, options);
    return res ?? { playlist: null, items: [] };
}

export async function resolve(url: string): Promise<NormalizedResult> {
    ensureAgent();
    // Delegate playlists to appropriate resolver: ytjs for mixes, ytpl for regular playlists
    try {
        const playlistId = extractPlaylistIdFromUrl(url);
        if (playlistId) {
            const isMix = /^RD/i.test(String(playlistId));
            if (isMix) {
                const mix = await ytjsResolveMix(url, playlistId);
                if (mix) return mix;
            } else {
                const pl = await ytplResolve(url);
                if (pl) return pl;
            }
        }
    } catch {}

    // Canonicalize to a proper watch URL if needed
    let target = url;
    if (!ytdl.validateURL(target)) {
        try {
            const vid = ytdl.getVideoID(target);
            target = `https://youtu.be/${vid}`;
        } catch {
            // Fall back to search
        }
    }

    if (ytdl.validateURL(target)) {
        let info: any;
        try {
            info = await ytdl.getBasicInfo(target, mergedYtdlOptions());
        } catch (e) {
            // Fallback try WEB client only (preserve agent)
            const base: any = { ...mergedYtdlOptions() };
            base.playerClients = ["WEB"] as any;
            info = await ytdl.getBasicInfo(target, base);
        }
        const d = info.videoDetails;

        const item: NormalizedItem = {
            source: "youtube",
            url: d.video_url || `https://youtu.be/${d.videoId}`,
            title: d.title ?? "Unknown",
            author: d.author?.name || (d.author as any)?.user || "Unknown",
            durationMS: (d.isLive ? 0 : toSecond(d.lengthSeconds)) * 1000,
            thumbnail: d.thumbnails?.sort((a: any, b: any) => b.width - a.width)?.[0]?.url,
            isLive: Boolean(d.isLive),
            views: parseNumber((d as any).viewCount || (d as any).view_count || (d as any).views),
            likes: parseNumber((d as any).likes),
            raw: {
                chapters: (d as any).chapters ?? [],
                storyboards: (d as any).storyboards ?? [],
                related: info.related_videos ?? [],
                info,
            },
        };

        return { playlist: null, items: [item] };
    }

    // Fallback to search
    return search(url);
}

export async function related(url: string): Promise<NormalizedResult> {
    ensureAgent();
    if (!ytdl.validateURL(url)) return search(url);

    const basic = await ytdl.getBasicInfo(url, mergedYtdlOptions());
    const related = (basic.related_videos?.filter((r: any) => r.id) ?? [])
        // Filter out ultra-short related results (likely Shorts/clips)
        .filter((r: any) => {
            const len = Number((r as any).length_seconds) || 0;
            return len === 0 || len >= 60; // keep if unknown or >= 60s
        });

    const items: NormalizedItem[] = related.map((r: any) => ({
        source: "youtube",
        url: `https://youtu.be/${r.id}`,
        title: r.title ?? "Unknown",
        author:
            typeof r.author === "string"
                ? r.author
                : r.author?.name || (r.author as any)?.user || "Unknown",
        durationMS: (r.isLive ? 0 : toSecond((r as any).length_seconds)) * 1000,
        thumbnail: r.thumbnails?.sort((a: any, b: any) => b.width - a.width)?.[0]?.url,
        isLive: Boolean(r.isLive),
        views: parseNumber((r as any).view_count),
        raw: r,
    }));

    return { playlist: null, items };
}

export async function streamUrl(url: string): Promise<string> {
    ensureAgent();
    let target = url;
    if (!ytdl.validateURL(target)) {
        try {
            const vid = ytdl.getVideoID(target);
            target = `https://youtu.be/${vid}`;
        } catch {
            throw new Error("CANNOT_RESOLVE_SONG");
        }
    }

    let info: any;
    try {
        info = await ytdl.getInfo(target, mergedYtdlOptions());
    } catch (e) {
        // Fallback: try WEB client only (some tokens/regions prefer WEB over TV)
        try {
            const base: any = { ...mergedYtdlOptions() };
            base.playerClients = ["WEB"] as any;
            info = await ytdl.getInfo(target, base);
        } catch {
            throw e;
        }
    }
    if (!info.formats?.length) throw new Error("UNAVAILABLE_VIDEO");

    const details = info.videoDetails as any;
    const isLive: boolean = Boolean(details?.isLive);

    const format = info.formats
        .filter((f: any) => f.hasAudio && (!isLive || f.isHLS))
        .sort((a: any, b: any) => Number(b.audioBitrate) - Number(a.audioBitrate) || Number(a.bitrate) - Number(b.bitrate))[0];

    if (!format) throw new Error("UNPLAYABLE_FORMATS");
    return format.url;
}

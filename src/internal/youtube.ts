import ytpl from "@distube/ytpl";
import ytsr from "@distube/ytsr";
import ytdl from "@distube/ytdl-core";
import * as ToughCookie from "tough-cookie";
import {
    msFromDurationLike,
    toSecond,
    parseNumber,
    clone,
    type NormalizedItem,
    type NormalizedResult,
} from "./utils.js";


export type YouTubeOptions = {
    // Accept a cookie header string (e.g. "SID=...; HSID=...;") or an array of Cookie objects
    cookies?: string | ytdl.Cookie[];
    ytdlOptions?: ytdl.getInfoOptions;
};


let _cookies: ytdl.Cookie[] | undefined;
let _ytdlOptions: ytdl.getInfoOptions = {};
let _agent: ReturnType<typeof ytdl.createAgent> | undefined;

function toCookieArray(cookies?: string | ytdl.Cookie[]): ytdl.Cookie[] | undefined {
    if (!cookies) return undefined;
    if (typeof cookies !== "string") return clone(cookies);
    try {
        // Split standard Cookie header into individual pairs and parse
        const arr = cookies
            .split(";")
            .map(c => c.trim())
            .filter(Boolean)
            .map(c => ToughCookie.Cookie.parse(c))
            .filter(Boolean) as unknown as ytdl.Cookie[];
        return arr;
    } catch {
        // Fallback: ignore invalid cookie string
        return undefined;
    }
}

export function configure(opts: YouTubeOptions = {}) {
    _cookies = toCookieArray(opts.cookies);
    _ytdlOptions = opts.ytdlOptions ? clone(opts.ytdlOptions) : {};
    _agent = ytdl.createAgent(_cookies);
    _ytdlOptions.agent = _agent;
}

function ensureAgent() {
    if (!_ytdlOptions.agent) {
        _agent = ytdl.createAgent(_cookies);
        _ytdlOptions.agent = _agent;
    }
}

function ytCookie(): string {
    const agent = _ytdlOptions.agent as any;
    if (!agent?.jar) return "";
    return agent.jar.getCookieStringSync?.("https://www.youtube.com") ?? "";
}

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const cookie = ytCookie();
    if (cookie) headers["cookie"] = cookie;
    return headers;
}

function mergedYtdlOptions(): ytdl.getInfoOptions {
    const base: ytdl.getInfoOptions = { ..._ytdlOptions };
    const h = authHeaders();
    base.requestOptions = { ...(base.requestOptions || {}), headers: { ...(base.requestOptions?.headers as any || {}), ...h } } as any;
    if (_ytdlOptions.agent) base.agent = _ytdlOptions.agent;
    return base;
}

// =============== SEARCH (video/playlist) ===============
export async function search(
    query: string,
    options: { type?: "video" | "playlist"; limit?: number; safeSearch?: boolean } = {},
): Promise<NormalizedResult> {
    ensureAgent();
    const limit = Math.min(options.limit ?? 20, 20);
    const { items } = await ytsr(query, {
        type: options.type ?? "video",
        limit,
        safeSearch: options.safeSearch ?? false,
        requestOptions: { headers: authHeaders() },
    });

    // Build, filter, and score candidates
    type Scored = { item: NormalizedItem; score: number };
    const scored: Scored[] = [];
    for (const i of items) {
        if (i.type !== "video") continue;
        const v = i as ytsr.Video;
        const url = v.url ?? `https://youtu.be/${v.id}`;
        const title = v.name ?? "Unknown";
        const author = v.author?.name ?? "Unknown";
        const durationMS = msFromDurationLike(v.duration ?? 0);

        // Down-rank Shorts and ultra-short clips instead of filtering them out
        const isShortForm = url.includes("/shorts/") || (durationMS > 0 && durationMS < 60_000);

        const tLower = (title || "").toLowerCase();

        let score = 0;
        // if (tLower.includes("official audio")) score += 1;

        // Slight penalty for short-form content (Shorts or <60s clips)
        if (isShortForm) score -= 1;

        // Negatives: -1 if negative keyword in title, unless explicitly requested in query
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

    scored.sort((a, b) => b.score - a.score);
    const outItems = scored.map(s => s.item).slice(0, limit);
    return { playlist: null, items: outItems };
}

// =============== RESOLVE (playlist or video) ===============
export async function resolve(url: string): Promise<NormalizedResult> {
    ensureAgent();

    // Try to extract playlist id from common YouTube URLs (watch/playlist with ?list=)
    const extractPlaylistId = (href: string): string | null => {
        try {
            const u = new URL(href);
            const list = u.searchParams.get("list");
            if (list && list.trim().length > 0) return list.trim();
        } catch {
            // ignore parse errors
        }
        return null;
    };

    const playlistId = extractPlaylistId(url) || (ytpl.validateID(url) ? url : null);

    if (playlistId) {
        try {
            const info = await ytpl(playlistId, {
                limit: Infinity,
                requestOptions: { headers: authHeaders() },
            });

            // If this looks like a dynamic Mix (RD*) and only yields 0/1 items via ytpl,
            // synthesize a playlist from the current video + related instead of returning a single track.
            if (/^RD/i.test(String(info.id || playlistId)) && (info.items.length <= 1)) {
                try {
                    const basic = ytdl.validateURL(url)
                        ? await ytdl.getBasicInfo(url, mergedYtdlOptions())
                        : null;
                    const firstItem: NormalizedItem | null = basic
                        ? {
                            source: "youtube",
                            url: basic.videoDetails.video_url || `https://youtu.be/${basic.videoDetails.videoId}`,
                            title: basic.videoDetails.title ?? "Unknown",
                            author: basic.videoDetails.author?.name || (basic.videoDetails.author as any)?.user || "Unknown",
                            durationMS: (basic.videoDetails.isLive ? 0 : toSecond(basic.videoDetails.lengthSeconds)) * 1000,
                            thumbnail: basic.videoDetails.thumbnails?.sort((a, b) => b.width - a.width)?.[0]?.url,
                            isLive: Boolean(basic.videoDetails.isLive),
                            raw: { info: basic },
                        }
                        : null;
                    const rel = ytdl.validateURL(url) ? await related(url) : await search(url);
                    const items = (firstItem ? [firstItem] : []).concat(rel.items);
                    return {
                        playlist: {
                            id: String(info.id || playlistId),
                            title: "YouTube Mix",
                            url,
                            thumbnail: firstItem?.thumbnail ?? rel.items[0]?.thumbnail,
                        },
                        items,
                    };
                } catch {
                    // If mix synthesis fails, fall back to the raw ytpl result below
                }
            }

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

            // ytpl has no top-level thumbnail; use first item
            const playlistThumb = info.items.find(x => !!x.thumbnail)?.thumbnail;

            return {
                playlist: {
                    id: info.id,
                    title: info.title,
                    url: info.url,
                    thumbnail: playlistThumb,            // <- using item thumbnail
                },
                items,
            };
        } catch (e) {
            // Some dynamic mixes (list starting with RD/ etc.) aren't supported by ytpl.
            // Fallback: treat as a pseudo-playlist built from the current video + related.
            if (/^RD/i.test(String(playlistId))) {
                try {
                    const basic = ytdl.validateURL(url)
                        ? await ytdl.getBasicInfo(url, mergedYtdlOptions())
                        : null;
                    const firstItem: NormalizedItem | null = basic
                        ? {
                            source: "youtube",
                            url: basic.videoDetails.video_url || `https://youtu.be/${basic.videoDetails.videoId}`,
                            title: basic.videoDetails.title ?? "Unknown",
                            author: basic.videoDetails.author?.name || (basic.videoDetails.author as any)?.user || "Unknown",
                            durationMS: (basic.videoDetails.isLive ? 0 : toSecond(basic.videoDetails.lengthSeconds)) * 1000,
                            thumbnail: basic.videoDetails.thumbnails?.sort((a, b) => b.width - a.width)?.[0]?.url,
                            isLive: Boolean(basic.videoDetails.isLive),
                            raw: { info: basic },
                        }
                        : null;
                    const rel = ytdl.validateURL(url) ? await related(url) : await search(url);
                    const items = (firstItem ? [firstItem] : []).concat(rel.items);
                    return {
                        playlist: {
                            id: String(playlistId),
                            title: "YouTube Mix",
                            url,
                            thumbnail: firstItem?.thumbnail ?? rel.items[0]?.thumbnail,
                        },
                        items,
                    };
                } catch {
                    // Ignore and fall through to normal handling
                }
            }
            // Non-mix playlist failed; fall through
        }
    }

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

// =============== RELATED ===============
export async function related(url: string): Promise<NormalizedResult> {
    ensureAgent();
    if (!ytdl.validateURL(url)) return search(url);

    const basic = await ytdl.getBasicInfo(url, mergedYtdlOptions());
    const related = (basic.related_videos?.filter(r => r.id) ?? [])
        // Filter out ultra-short related results (likely Shorts/clips)
        .filter(r => {
            const len = Number((r as any).length_seconds) || 0;
            return len === 0 || len >= 60; // keep if unknown or >= 60s
        });

    const items: NormalizedItem[] = related.map(r => ({
        source: "youtube",
        url: `https://youtu.be/${r.id}`,
        title: r.title ?? "Unknown",
        author:
            typeof r.author === "string"
                ? r.author
                : r.author?.name || (r.author as any)?.user || "Unknown",
        durationMS: (r.isLive ? 0 : toSecond((r as any).length_seconds)) * 1000,
        thumbnail: r.thumbnails?.sort((a, b) => b.width - a.width)?.[0]?.url,
        isLive: Boolean(r.isLive),
        views: parseNumber((r as any).view_count),
        raw: r,
    }));

    return { playlist: null, items };
}

// =============== STREAM URL ===============
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

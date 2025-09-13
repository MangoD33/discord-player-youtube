import type { ExtractorSearchContext } from "discord-player";
import { Track, Playlist, Util } from "discord-player";
import { randomBytes } from "node:crypto";
import * as ToughCookie from "tough-cookie";
import * as youtube from "./youtube.js";
import ytdl, { ytdlResolveVideo } from "./ytdl.js";
import { ytjsSearch, ytjsResolvePlaylist, ytjsResolveMix, ytjsResolveVideo, streamUrl as ytjsStreamUrl } from "./ytjs.js";
import ytdlp from "./ytdlp.js";
import type { Cookie as YTDLCookie } from "./ytdl.js";
import { ytsrSearch } from "./ytsr.js";
import { ytplResolve } from "./ytpl.js";

export async function dispatchRelated(track: Track): Promise<NormalizedResult> {
    return youtube.related(track.url);
}

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
        metadata: { source: item.raw, bridge: (item as any).raw?.bridge ?? null },
        requestMetadata: async () => ({ source: item.raw, bridge: (item as any).raw?.bridge ?? null }),
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

// OAuth token shape for youtubei.js TV OAuth sign-in
export type OAuth2Tokens = {
    access_token: string;
    expiry_date: number; // epoch millis
    expires_in?: number;
    refresh_token: string;
    scope?: string;
    token_type?: string;
    client?: string;
};

// Parses a semicolon-separated key=value string into an OAuth2Tokens object
// Example string: "access_token=...; expiry_date=...; refresh_token=...; ..."
export function tokenToObject(token: string): OAuth2Tokens {
    if (!token.includes("; ") || !token.includes("="))
        throw new Error(
            "Error: this is not a valid authentication token. Make sure you are putting the entire string instead of just what's behind access_token=",
        );

    const kvPair = token.split("; ");

    const validKeys = [
        "access_token",
        "expiry_date",
        "expires_in",
        "refresh_token",
        "scope",
        "token_type",
        "client",
    ];
    let finalObject: Partial<OAuth2Tokens> = {};
    for (const kv of kvPair) {
        const [key, value] = kv.split("=");
        if (!validKeys.includes(key)) continue;
        (finalObject as any)[key as keyof OAuth2Tokens] = Number.isNaN(Number(value))
            ? value
            : Number(value);
    }

    // perform final checks
    const requiredKeys = ["access_token", "expiry_date", "refresh_token"] as const;

    for (const key of requiredKeys) {
        if (!(key in finalObject))
            throw new Error(
                `Error: Invalid authentication keys. Missing the required key ${key}. Make sure you are putting the entire string instead of just what's behind access_token=`,
            );
    }

    return finalObject as OAuth2Tokens;
}

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

export function toCookieArray(cookies?: string | YTDLCookie[]): YTDLCookie[] | undefined {
    if (!cookies) return undefined;
    if (typeof cookies !== "string") return clone(cookies);
    try {
        const arr = cookies
            .split(";")
            .map(c => c.trim())
            .filter(Boolean)
            .map(c => ToughCookie.Cookie.parse(c))
            .filter(Boolean) as unknown as YTDLCookie[];
        return arr;
    } catch {
        return undefined;
    }
}

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

export async function dispatchResolve(url: string): Promise<NormalizedResult> {
    return resolveViaPriority(url);
}


// Priority configuration
export type Aspect = 'search' | 'playlist' | 'mix' | 'video' | 'stream' | 'bridge';
export type Provider = 'ytdl' | 'ytjs' | 'ytdlp' | 'ytsr' | 'ytpl';

const defaultPriorities: Record<Aspect, Provider[]> = {
    search: ['ytjs', 'ytsr'],
    playlist: ['ytjs', 'ytpl'],
    // For mixes, rely solely on ytjs
    mix: ['ytjs'],
    video: ['ytjs', 'ytdl'],
    stream: ['ytjs', 'ytdl', 'ytdlp'],
    bridge: ['ytjs', 'ytdl'],
};

let priorityOverrides: Partial<Record<Aspect, Provider[]>> = {};

export function setPriorities(p: Partial<Record<Aspect, Provider[]>>) {
    priorityOverrides = { ...priorityOverrides, ...p };
}

export function getPriorities(): Record<Aspect, Provider[]> {
    const out = { ...defaultPriorities } as Record<Aspect, Provider[]>;
    for (const k of Object.keys(priorityOverrides) as Array<Aspect>) {
        const v = priorityOverrides[k];
        if (v && Array.isArray(v)) out[k] = v as Provider[];
    }
    return out;
}

// Global stream options configured via extractor registration
export type StreamOptions = { useClient?: string; highWaterMark?: number };
let _streamOptions: StreamOptions = {};
export function setStreamOptions(opts: StreamOptions = {}) { _streamOptions = { ..._streamOptions, ...opts }; }
export function getStreamOptions(): StreamOptions { return { ..._streamOptions }; }

export async function streamViaPriority(url: string): Promise<string> {
    const order = getPriorities().stream;
    let lastErr: any = null;
    for (const p of order) {
        try {
            if (p === 'ytdl') return await ytdl.streamUrl(url);
            if (p === 'ytjs') return await ytjsStreamUrl(url, ytdl.cookie(), _streamOptions.useClient);
            if (p === 'ytdlp') return await ytdlp.streamUrl(url);
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('NO_STREAM_PROVIDER');
}

function extractPlaylistIdFromUrl(href: string): string | null {
    try { const u = new URL(href); const list = u.searchParams.get("list"); if (list && list.trim().length > 0) return list.trim(); } catch { }
    return null;
}
// ytsr/ytpl are handled by dedicated modules

export async function searchViaPriority(query: string, options?: any): Promise<NormalizedResult> {
    const order = getPriorities().search;
    for (const p of order) {
        try {
            if (p === 'ytjs') { const r = await ytjsSearch(query, options); if (r?.items?.length) return r; }
            if (p === 'ytsr') { const r = await ytsrSearch(query, options); if (r?.items?.length) return r; }
        } catch { /* ignore and try next provider */ }
    }
    return { playlist: null, items: [] };
}

export async function resolveViaPriority(url: string): Promise<NormalizedResult> {
    const playlistId = extractPlaylistIdFromUrl(url);
    if (playlistId) {
        const isMix = /^RD/i.test(String(playlistId)); const order = getPriorities()[isMix ? 'mix' : 'playlist'];
        for (const p of order) {
            try {
                if (isMix) {
                    if (p === 'ytjs') { const r = await ytjsResolveMix(url, playlistId); if (r) return r; }
                } else {
                    if (p === 'ytjs') { const r = await ytjsResolvePlaylist(playlistId, url); if (r) return r; }
                    if (p === 'ytpl') { const r = await ytplResolve(url); if (r) return r; }
                }
            } catch { }
        }
    }
    const vorder = getPriorities().video;
    for (const p of vorder) {
        try {
            if (p === 'ytjs') { const r = await ytjsResolveVideo(url); if (r) return r; }
            if (p === 'ytdl') { const r = await ytdlResolveVideo(url); if (r) return r; }
        } catch { }
    }
    return searchViaPriority(url, { type: 'video', limit: 1 });
}

// PoToken generator: create a URL-safe base64 token (cached per process)
let _poTokenCache: string | undefined;
export function generatePoToken(): string {
    if (_poTokenCache) return _poTokenCache;
    try {
        const buf = randomBytes(32);
        const tok = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        _poTokenCache = tok;
        return tok;
    } catch {
        // Fallback: pseudo-random ascii if crypto unavailable
        const tok = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
        _poTokenCache = tok;
        return tok;
    }
}

// Attempts to generate a PoToken using bgutils-js + jsdom, given an Innertube client.
// Falls back to generatePoToken() if dependencies are missing or generation fails.
export async function generatePoTokenForInnertube(innertube: any): Promise<string> {
    try {
        if (!innertube?.session?.context?.client?.visitorData)
            throw new Error('Missing visitorData');

        // Dynamic imports to avoid hard dependency at build time
        const jsdomMod: any = await import('jsdom');
        const { JSDOM } = jsdomMod as any;
        const bgMod: any = await import('bgutils-js');
        const BG = (bgMod as any).BG ?? bgMod.BG ?? bgMod.default?.BG ?? bgMod.default;
        if (!BG)
            throw new Error('bgutils-js BG not available');

        const requestKey = 'O43z0dpjhgX20SCx4KAo';
        const visitorData: string = innertube.session.context.client.visitorData;

        const bgConfig: any = {
            fetch: (input: any, init?: any) => (globalThis as any).fetch(input, init),
            globalObj: globalThis,
            identifier: visitorData,
            requestKey,
        };

        // Setup minimal DOM environment
        const dom = new JSDOM();
        (globalThis as any).window = dom.window as any;
        (globalThis as any).document = dom.window.document as any;

        try {
            const challenge = await BG.Challenge.create(bgConfig);
            if (!challenge) throw new Error('Could not create BG challenge');

            const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
            if (!interpreter) throw new Error('Missing interpreter JavaScript');
            // Execute the interpreter in the current global scope
            new Function(interpreter)();

            const tokenResult = await BG.PoToken.generate({
                program: challenge.program,
                globalName: challenge.globalName,
                bgConfig,
            });

            // Common result shapes: tokenResult.token or tokenResult.poToken
            const token = (tokenResult as any)?.token ?? (tokenResult as any)?.poToken ?? (tokenResult as any)?.value;
            if (!token) throw new Error('PoToken missing in result');

            return String(token);
        } finally {
            try { (globalThis as any).document?.close?.(); } catch { }
            // cleanup
            try { delete (globalThis as any).window; } catch { }
            try { delete (globalThis as any).document; } catch { }
        }
    } catch {
        return generatePoToken();
    }
}

// Simple HTTP reader for a given URL with optional buffering highWaterMark
// Returns a Readable stream piped through a PassThrough using the provided highWaterMark
export async function createReadableFromUrl(url: string, highWaterMark?: number): Promise<import('stream').Readable> {
    const { request } = await import('undici');
    const { PassThrough } = await import('stream');
    const headers: Record<string, string> = {};
    try {
        const c = ytdl.cookie();
        if (c) headers['cookie'] = c;
    } catch { /* ignore */ }
    const res = await request(url, { headers });
    if (res.statusCode >= 400) throw new Error(`HTTP_${res.statusCode}`);
    const pass = new PassThrough({ highWaterMark: typeof highWaterMark === 'number' && highWaterMark > 0 ? highWaterMark : undefined });
    (res.body as any).pipe(pass);
    return pass;
}

import {
    BaseExtractor,
    type ExtractorInfo,
    type ExtractorSearchContext,
    type SearchQueryType,
    type Track,
} from "discord-player";

import {
    dispatchResolve,
    dispatchRelated,
    buildTrack,
    buildPlaylistMeta,
    streamViaPriority,
    type NormalizedItem,
    searchViaPriority
} from "./internal/utils.js";

import * as yt from "./internal/youtube.js";
import { configureYTJS } from "./internal/ytjs.js";
import type { YouTubeOptions } from "./internal/youtube.js";
import { QueryType } from "discord-player";
import { setStreamOptions, getStreamOptions, createReadableFromUrl } from "./internal/utils.js";

type ExtractorInitOptions = {
    youtube?: import("./internal/youtube.js").YouTubeOptions;
    // Optional: override extractor registration priority (higher runs first)
    priority?: number;
    // Optional: TV OAuth tokens string for youtubei.js sign-in (semicolon-separated key=value pairs)
    authentication?: string;
    // Optional: cookie for youtubei.js (string, cookie jar, or array of cookies)
    cookie?: any;
    // Optional: generate and use a PoToken for youtubei.js
    generateWithPoToken?: boolean;
    // Optional: control streaming behavior
    streamOptions?: {
        // Preferred Innertube client for stream URL selection (e.g. 'ANDROID', 'WEB', 'TV', 'ANDROID_MUSIC')
        useClient?: string;
        // If provided, the extractor will create and return a Readable stream piped through a PassThrough
        // with this highWaterMark instead of returning the URL string.
        highWaterMark?: number;
    };
};

export type BridgeResult = { url: string; streamUrl: string; item: NormalizedItem };

export class YouTubeExtractor extends BaseExtractor<ExtractorInitOptions> {
    static identifier = "com.discord-player.mangod33.youtube-extractor" as const;
    public priority = 2;

    async activate(): Promise<void> {
        const init = (this.options || {}) as ExtractorInitOptions;
        if (typeof init.priority === "number" && Number.isFinite(init.priority)) {
            this.priority = init.priority;
        }
        yt.configure(init.youtube ?? {});
        configureYTJS({ authentication: init.authentication, cookie: init.cookie, generateWithPoToken: init.generateWithPoToken });
        if (init.streamOptions) setStreamOptions(init.streamOptions);
        this.protocols = ["ytsearch", "yt", "youtube"];
    }

    async deactivate(): Promise<void> {
        this.protocols = [];
    }

    async validate(query: string, type: SearchQueryType): Promise<boolean> {
        if (typeof query !== "string") return false;
        const allowed: SearchQueryType[] = [
            QueryType.YOUTUBE,
            QueryType.YOUTUBE_PLAYLIST,
            QueryType.YOUTUBE_SEARCH,
            QueryType.YOUTUBE_VIDEO,
            QueryType.AUTO,
            QueryType.AUTO_SEARCH
        ];
        return allowed.includes(type as SearchQueryType);
    }

    async handle(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        if (context.protocol === "ytsearch") context.type = QueryType.YOUTUBE_SEARCH;
        query = query.includes("youtube.com") ? query.replace(/(m(usic)?|gaming)\./, "") : query;

        const isSearch = context.type === QueryType.YOUTUBE_SEARCH || context.type === QueryType.AUTO_SEARCH;
        const resolved = isSearch
            ? await searchViaPriority(query, { type: "video", limit: 20 })
            : await dispatchResolve(query);

        const playlistObj = resolved.playlist ? buildPlaylistMeta(this.context.player, resolved.playlist) : null;
        const tracks: Track[] = resolved.items.map(i => buildTrack(this.context.player, i, context, playlistObj, this));
        if (playlistObj) playlistObj.tracks = tracks;
        return this.createResponse(playlistObj, tracks);
    }

    async stream(track: Track) {
        const url = await streamViaPriority(track.url);
        const so = getStreamOptions();
        if (so?.highWaterMark && Number(so.highWaterMark) > 0) {
            // Create and return a buffered stream with desired highWaterMark
            return await createReadableFromUrl(url, so.highWaterMark);
        }
        return url;
    }

    async getRelatedTracks(track: Track): Promise<ExtractorInfo> {
        const related = await dispatchRelated(track);
        const ctx = { requestedBy: track.requestedBy } as ExtractorSearchContext;
        const tracks: Track[] = related.items.map(i => buildTrack(this.context.player, i, ctx, null, this));
        return this.createResponse(null, tracks);
    }

    static async bridge(
        query: string,
        opts?: { youtube?: YouTubeOptions }
    ): Promise<BridgeResult | null> {
        if (opts?.youtube) yt.configure(opts.youtube);
        let effective = query;
        try {
            const lower = (query || "").toLowerCase();
            const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
            const wantsAlt = [
                "live", "cover", "remix", "mix", "sped", "slowed", "nightcore", "8d", "edit", "mashup", "reverb", "lyrics", "lyric",
            ].some(w => tokens.has(w));
            const mentionsOfficial = lower.includes("official audio") || lower.includes("official video") || tokens.has("official");
            if (!wantsAlt && !mentionsOfficial) effective = `${query} official audio`;
        } catch { }
        const res = await yt.search(effective, { type: "video", limit: 1 });
        const top = res.items[0];
        if (!top) return null;
        const streamUrl = await streamViaPriority(top.url);
        return { url: top.url, streamUrl, item: top };
    }
}

export default YouTubeExtractor;

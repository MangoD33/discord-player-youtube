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
    dispatchStream,
    buildTrack,
    buildPlaylistMeta,
    type NormalizedItem
} from "./internal/utils.js";


import * as yt from "./internal/youtube.js";
import type { YouTubeOptions } from "./internal/youtube.js";
import { QueryType } from "discord-player";

type ExtractorInitOptions = {
    youtube?: import("./internal/youtube.js").YouTubeOptions;
};

export type BridgeResult = { url: string; streamUrl: string; item: NormalizedItem };

export class DisTubeExtractor extends BaseExtractor<ExtractorInitOptions> {
    static identifier = "com.discord-player.mangod33.distube-extractor" as const;

    async activate(): Promise<void> {
        const init = (this.options || {}) as ExtractorInitOptions;
        yt.configure(init.youtube ?? {});
        this.protocols = ["distube", "yt", "youtube"];
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

    // Track/Playlist builders moved to internal/utils

    async handle(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        if (context.protocol === "ytsearch")
            context.type = QueryType.YOUTUBE_SEARCH;
        query = query.includes("youtube.com")
            ? query.replace(/(m(usic)?|gaming)\./, "")
            : query;
        // Resolve URL or fallback to search internally
        const resolved = await dispatchResolve(query);
        const playlistObj = resolved.playlist
            ? buildPlaylistMeta(this.context.player, resolved.playlist)
            : null;
        const tracks: Track[] = resolved.items.map(i => buildTrack(this.context.player, i, context, playlistObj, this));
        // Ensure discord-player consumers see tracks on the playlist object as well
        if (playlistObj) playlistObj.tracks = tracks;
        return this.createResponse(playlistObj, tracks);
    }

    async stream(track: Track) {
        return dispatchStream(track);
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

        // Bias towards clean uploads when bridging generic queries.
        // If the user did not explicitly ask for alternative versions
        // (remix/mix/live/cover/etc) then append "official audio" to the query.
        let effective = query;
        try {
            const lower = (query || "").toLowerCase();
            const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
            const wantsAlt = [
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
            ].some(w => tokens.has(w));
            const mentionsOfficial = lower.includes("official audio") || lower.includes("official video") || tokens.has("official");
            if (!wantsAlt && !mentionsOfficial) effective = `${query} official audio`;
        } catch {
            // ignore tokenization issues; fall back to original query
        }

        const res = await yt.search(effective, { type: "video", limit: 1 });
        const top = res.items[0];
        if (!top) return null;
        const stream = await yt.streamUrl(top.url);
        return { url: top.url, streamUrl: stream, item: top };
    }
}

export default DisTubeExtractor;

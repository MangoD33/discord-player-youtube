import { BaseExtractor, GuildQueueHistory, Playlist, Track, Util } from "discord-player";
import type { ExtractorInfo, ExtractorSearchContext, ExtractorStreamable, SearchQueryType } from "discord-player";
import { Innertube, YTNodes, YT } from "youtubei.js/agnostic";
import { getInnertube } from "./internal/getInnertube.js";
import { createSabrStream } from "./internal/createSabr.js";
import { Readable } from "node:stream";

export class YoutubeExtractor extends BaseExtractor {
    public static identifier: string = "com.mangod33.discord-player-youtube";

    private innertube: Innertube | null = null;
    private _stream: Function | null = null;

    async activate(): Promise<void> {
        this.protocols = ["youtube", "yt"];
        this.innertube = await getInnertube();

        const fn = (this.options as any).createStream;
        if (typeof fn === "function") this._stream = (q: any) => { return fn(this, q) };
    }

    async deactivate(): Promise<void> {
        this._stream = null;
        this.innertube = null;
    }

    async validate(query: string, type?: SearchQueryType | null): Promise<boolean> {
        if (typeof query !== "string") return false;
        return true;
    }

    async handle(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        if (!checkIsUrl(query)) {
            let topResults: any[];
            let results: YT.Search | undefined;
            let trackResponse: Track[] = new Array<Track>;

            try {
                if (!this.innertube) throw new Error('Innertube not initialized');
                results = await searchYoutubeByQueryName(this.innertube, query);
                if (!results) return this.createResponse(null, []);

                topResults = results.results.filter((video: any): video is YTNodes.Video => video.type === 'Video' && !!video.video_id).slice(0, 3);
                for (const r of topResults) {
                    let videoId: string = r.video_id;

                    const info = await this.innertube.getBasicInfo(videoId);
                    let durationMs: number = (info.basic_info?.duration ?? 0) * 1000;

                    let trackObj: Track = new Track(this.context.player, {
                        title: info.basic_info?.title ?? "UNKNOWN TITLE",
                        author: info.basic_info?.author ?? "UNKNOWN AUTHOR",
                        thumbnail: info.basic_info?.thumbnail?.[0]?.url ?? undefined,
                        url: `https://www.youtube.com/watch?v=${videoId}`,
                        duration: Util.buildTimeCode(Util.parseMS(durationMs)),
                        source: "youtube",
                        requestedBy: context.requestedBy ?? undefined,
                        raw: {
                            basicInfo: info,
                            live: info.basic_info?.is_live || false,
                        },
                    });
                    trackResponse.push(trackObj);
                }
                return this.createResponse(null, trackResponse);
            } catch (error) {
                console.error(`[Youtube Extractor Error] Error while searching by name: ${error}`);
                return this.createResponse(null, []);
            }
        }

        try {
            let isPlaylist: boolean = false;
            let playlistId: string | null = null;

            try {
                const urlObj = new URL(query);
                const hasList: boolean = urlObj.searchParams.has("list");
                const isShortLink: boolean = /(^|\.)youtu\.be$/i.test(urlObj.hostname);

                isPlaylist = hasList && !isShortLink;
                playlistId = isPlaylist ? urlObj.searchParams.get("list") : null;
            } catch {
                const m = query.match(/[?&]list=([a-zA-Z0-9_-]+)/);
                isPlaylist = !!m;
                playlistId = m?.[1] ?? null;
            }

            if (isPlaylist && playlistId) {
                if (!this.innertube) throw new Error('Innertube not initialized');
                let playlist = await this.innertube.getPlaylist(playlistId);
                if (!playlist?.videos?.length) return this.createResponse(null, []);

                const dpPlaylist = new Playlist(this.context.player, {
                    id: playlistId,
                    title: playlist.info.title ?? "UNKNOWN TITLE",
                    url: query,
                    thumbnail: playlist.info.thumbnails[0]?.url ?? undefined,
                    description: playlist.info.description ?? "UNKNOWN DESCRIPTION",
                    source: "youtube",
                    type: "playlist",
                    author: {
                        name:
                            playlist?.channels[0]?.author?.name ??
                            playlist.info.author.name ??
                            "UNKNOWN AUTHOR",
                        url:
                            playlist?.channels[0]?.author?.url ??
                            playlist.info.author.url ??
                            "UNKNOWN AUTHOR",
                    },
                    tracks: [],
                });

                dpPlaylist.tracks = [];

                const playlistTracks = (
                    playlist.videos.filter((v): v is YTNodes.PlaylistVideo => v.type === "PlaylistVideo")
                ).map((v: YTNodes.PlaylistVideo) => {
                    const duration = Util.buildTimeCode(Util.parseMS(v.duration.seconds * 1000));
                    const raw = {
                        duration_ms: v.duration.seconds * 1000,
                        live: v.is_live,
                        duration,
                    };

                    return new Track(this.context.player, {
                        title: v.title.text ?? "UNKNOWN TITLE",
                        duration: duration,
                        thumbnail: v.thumbnails[0]?.url ?? undefined,
                        author: v.author.name,
                        requestedBy: context.requestedBy,
                        url: `https://youtube.com/watch?v=${v.id}`,
                        raw,
                        playlist: dpPlaylist,
                        source: "youtube",
                        queryType: "youtubeVideo",
                        metadata: raw,
                        live: v.is_live,
                    });
                });

                while (playlist.has_continuation) {
                    playlist = await playlist.getContinuation();

                    playlistTracks.push(...(
                        playlist.videos.filter((v): v is YTNodes.PlaylistVideo => v.type === "PlaylistVideo")).map((v: YTNodes.PlaylistVideo) => {
                            const duration = Util.buildTimeCode(Util.parseMS(v.duration.seconds * 1000));
                            const raw = {
                                duration_ms: v.duration.seconds * 1000,
                                live: v.is_live,
                                duration,
                            };

                            return new Track(this.context.player, {
                                title: v.title.text ?? "UNKNOWN TITLE",
                                duration,
                                thumbnail: v.thumbnails[0]?.url ?? undefined,
                                author: v.author.name,
                                requestedBy: context.requestedBy,
                                url: `https://youtube.com/watch?v=${v.id}`,
                                raw,
                                playlist: dpPlaylist,
                                source: "youtube",
                                queryType: "youtubeVideo",
                                metadata: raw,
                                live: v.is_live,
                            });
                        }),
                    );
                }

                dpPlaylist.tracks = playlistTracks;

                return this.createResponse(dpPlaylist, playlistTracks);
            }

            const videoId: string | null = extractVideoId(query);
            if (!videoId) return this.createResponse(null, []);

            if (!this.innertube) throw new Error('Innertube not initialized');
            const info = await this.innertube.getBasicInfo(videoId!);
            const durationMs = (info.basic_info?.duration ?? 0) * 1000;

            const trackObj = new Track(this.context.player, {
                title: info.basic_info?.title ?? "UNKNOWN TITLE",
                author: info.basic_info?.author ?? "UNKNOWN AUTHOR",
                thumbnail: info.basic_info?.thumbnail?.[0]?.url ?? undefined,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                duration: Util.buildTimeCode(Util.parseMS(durationMs)),
                source: "youtube",
                requestedBy: context.requestedBy ?? undefined,
                raw: {
                    basicInfo: info,
                    live: info.basic_info?.is_live || false,
                },
            });

            return this.createResponse(null, [trackObj]);
        } catch (error) {
            console.error(`[YoutubeiExtractor Error]: ${error}`);
            return this.createResponse(null, []);
        }
    }

    async stream(track: Track): Promise<ExtractorStreamable> {
        try {
            if (!this.innertube) throw new Error("Innertube not initialized.");

            const videoId = extractVideoId(track.url || (track.raw as any)?.id || "");
            if (!videoId) throw new Error("Unable to extract videoId.");

            const nodeStream = await createSabrStream(videoId);
            if (!nodeStream) throw new Error('Failed to create stream');

            return nodeStream;
        } catch (error) {
            console.error(`[Youtubei Extractor Error] Error while creating stream: ${error}`);
            throw error;
        }
    }

    async getRelatedTracks(track: Track, history: GuildQueueHistory): Promise<ExtractorInfo> {
        if (!this.innertube) throw new Error('Innertube not initialized');
        let videoId = extractVideoId(track.url);
        if (!videoId) throw new Error("[YoutubeiExtractor Error] Error at getRelatedTracks(): Unable to extract videoId.");

        const info = await this.innertube.getInfo(videoId);
        const next = info.watch_next_feed;

        const recommended = (next as unknown as YTNodes.CompactVideo[]).filter((v: any) => !history.tracks.some((x) => x.url === `https://youtube.com/watch?v=${v.id}`) && v.type === "CompactVideo");

        if (!recommended) {
            this.context.player.debug("Unable to fetch recommendations.");
            return this.createResponse(null, []);
        }

        const trackConstruct = recommended.map((v) => {
            const duration = Util.buildTimeCode(Util.parseMS(v.duration.seconds * 1000));
            const raw = {
                live: v.is_live,
                duration_ms: v.duration.seconds * 1000,
                duration,
            };

            return new Track(this.context.player, {
                title: v.title?.text ?? "UNKNOWN TITLE",
                thumbnail: v.best_thumbnail?.url ?? v.thumbnails[0]?.url,
                author: v.author?.name ?? "UNKNOWN AUTHOR",
                requestedBy: track.requestedBy ?? undefined,
                url: `https://youtube.com/watch?v=${v.video_id}`,
                source: "youtube",
                duration,
                raw,
            });
        });

        return this.createResponse(null, trackConstruct);
    }
}

function extractVideoId(vid: any): string | null {
    if (typeof vid !== 'string' || !new RegExp('^https:\/\/(www\.)?youtu(\.be\/.{11}(.+)?|be\.com\/watch\?v=.{11}(&.+)?)/').test(vid)) return null;

    let id: string | null = new URL(vid).searchParams.get("v");
    if (!id) {
        const last = vid.split("/").at(-1);
        id = last ? (last.split("?").at(0) ?? null) : null;
    }

    return id;
}

async function searchYoutubeByQueryName(innertube: Innertube, query: string): Promise<YT.Search | undefined> {
    let search: YT.Search | undefined;
    try {
        search = await innertube.search(query);
        if (!search || search.results.length === 0) return undefined;
    } catch (error) {
        console.error(`[Youtube Extractor Error] Error while searching by name: ${error}`);
    }
    return search;
}

function checkIsUrl(query: string): boolean {
    let isUrl: boolean;
    try {
        new URL(query);
        isUrl = true;
    } catch (error) {
        isUrl = false;
    }
    return isUrl || new RegExp('^https?://(www\\.)?(youtube\\.com|youtu\\.be)/', 'i').test(query);
}

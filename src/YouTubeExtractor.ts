import {
  BaseExtractor,
  GuildQueueHistory,
  Playlist,
  Track,
  Util,
} from "discord-player";
import type {
  ExtractorInfo,
  ExtractorSearchContext,
  ExtractorStreamable,
  SearchQueryType,
} from "discord-player";
import { Innertube, YTNodes, YT } from "youtubei.js/agnostic";
import { getInnertube } from "./internal/getInnertube.js";
import {
  buildTrack,
  buildPlaylistMeta,
  msFromDurationLike,
  textFromRuns,
  extractVideoId,
  searchYoutubeByQueryName,
  checkIsUrl,
  type NormalizedItem,
} from "./internal/utils.js";
import { createSabrStream } from "./internal/createSabr.js";

export class YoutubeExtractor extends BaseExtractor {
  public static identifier: string = "com.mangod33.discord-player-youtube";

  private innertube: Innertube | null = null;
  private _stream: Function | null = null;

  async activate(): Promise<void> {
    this.protocols = ["youtube", "yt"];
    this.innertube = await getInnertube();

    const fn = (this.options as any).createStream;
    if (typeof fn === "function")
      this._stream = (q: any) => {
        return fn(this, q);
      };
  }

  async deactivate(): Promise<void> {
    this._stream = null;
    this.innertube = null;
  }

  async validate(
    query: string,
    type?: SearchQueryType | null
  ): Promise<boolean> {
    if (typeof query !== "string") return false;
    return true;
  }

  async handle(
    query: string,
    context: ExtractorSearchContext
  ): Promise<ExtractorInfo> {
    if (!checkIsUrl(query)) {
      try {
        if (!this.innertube) throw new Error("Innertube not initialized");

        const results = await searchYoutubeByQueryName(this.innertube, query);
        if (!results) return this.createResponse(null, []);

        const topResults = results.results
          .filter(
            (video: any): video is YTNodes.Video =>
              video?.type === "Video" && !!video?.video_id
          )
          .slice(0, 20);

        const tracks: Track[] = topResults.map((r) => {
          const item: NormalizedItem = {
            source: "youtube",
            url: `https://www.youtube.com/watch?v=${r.video_id}`,
            title: r.title?.text ?? "UNKNOWN TITLE",
            author: r.author?.name ?? "UNKNOWN AUTHOR",
            durationMS: (r.duration?.seconds ?? 0) * 1000,
            thumbnail: r.best_thumbnail?.url ?? r.thumbnails?.[0]?.url,
            isLive: !!r.is_live,
            raw: r,
          };
          return buildTrack(this.context.player, item, context, null, this);
        });

        return this.createResponse(null, tracks);
      } catch (error) {
        console.error(`[YouTubeExtractor] Search by name failed: ${error}`);
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
        if (!this.innertube) throw new Error("Innertube not initialized");
        const isMix = playlistId.startsWith("RD");

        if (isMix) {
          // Resolve YouTube Mix via /next endpoint
          const videoIdFromUrl = extractVideoId(query);
          const resp = await this.innertube.actions.execute("/next", {
            videoId: videoIdFromUrl ?? undefined,
            playlistId,
          });
          const root: any = (resp as any)?.data ?? {};
          const playlistRoot: any =
            root?.contents?.twoColumnWatchNextResults?.playlist?.playlist;
          const contents: any[] = playlistRoot?.contents || [];
          if (!contents.length) return this.createResponse(null, []);

          const metaTitle = textFromRuns(playlistRoot?.title) || "YouTube Mix";
          const dpPlaylist = buildPlaylistMeta(this.context.player, {
            id: playlistId,
            title: metaTitle,
            url: query,
            thumbnail: undefined,
          });

          const tracks = contents
            .map((c: any) => (c as any).playlistPanelVideoRenderer)
            .filter((v: any) => v?.videoId)
            .map((v: any) => {
              const item: NormalizedItem = {
                source: "youtube",
                url: `https://youtu.be/${v.videoId}`,
                title: textFromRuns(v.title) || "UNKNOWN TITLE",
                author:
                  textFromRuns(v.shortBylineText) ||
                  textFromRuns(v.longBylineText) ||
                  "UNKNOWN AUTHOR",
                durationMS: msFromDurationLike(
                  textFromRuns(v.lengthText) || "0:00"
                ),
                thumbnail: v.thumbnail?.[0]?.url ?? null,
                isLive: !v.lengthText,
                raw: v,
              };
              return buildTrack(
                this.context.player,
                item,
                context,
                dpPlaylist,
                this
              );
            });

          dpPlaylist.tracks = tracks;
          return this.createResponse(dpPlaylist, tracks);
        }

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

        const playlistTracks = playlist.videos
          .filter((v): v is YTNodes.PlaylistVideo => v.type === "PlaylistVideo")
          .map((v: YTNodes.PlaylistVideo) => {
            const item: NormalizedItem = {
              source: "youtube",
              url: `https://youtube.com/watch?v=${v.id}`,
              title: v.title.text ?? "UNKNOWN TITLE",
              author: v.author?.name ?? "UNKNOWN AUTHOR",
              durationMS: (v.duration?.seconds ?? 0) * 1000,
              thumbnail: v.thumbnails?.[0]?.url ?? undefined,
              isLive: v.is_live,
              raw: v,
            };
            return buildTrack(
              this.context.player,
              item,
              context,
              dpPlaylist,
              this
            );
          });

        while (playlist.has_continuation) {
          playlist = await playlist.getContinuation();

          playlistTracks.push(
            ...playlist.videos
              .filter(
                (v): v is YTNodes.PlaylistVideo => v.type === "PlaylistVideo"
              )
              .map((v: YTNodes.PlaylistVideo) => {
                const item: NormalizedItem = {
                  source: "youtube",
                  url: `https://youtube.com/watch?v=${v.id}`,
                  title: v.title.text ?? "UNKNOWN TITLE",
                  author: v.author?.name ?? "UNKNOWN AUTHOR",
                  durationMS: (v.duration?.seconds ?? 0) * 1000,
                  thumbnail: v.thumbnails?.[0]?.url ?? undefined,
                  isLive: v.is_live,
                  raw: v,
                };
                return buildTrack(
                  this.context.player,
                  item,
                  context,
                  dpPlaylist,
                  this
                );
              })
          );
        }

        dpPlaylist.tracks = playlistTracks;

        return this.createResponse(dpPlaylist, playlistTracks);
      }

      const videoId: string | null = extractVideoId(query);
      if (!videoId) return this.createResponse(null, []);

      if (!this.innertube) throw new Error("Innertube not initialized");
      const info = await this.innertube.getBasicInfo(videoId!);
      const item: NormalizedItem = {
        source: "youtube",
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: info.basic_info?.title ?? "UNKNOWN TITLE",
        author: (info.basic_info?.author as any) ?? "UNKNOWN AUTHOR",
        durationMS: (info.basic_info?.duration ?? 0) * 1000,
        thumbnail: info.basic_info?.thumbnail?.[0]?.url ?? undefined,
        isLive: info.basic_info?.is_live || false,
        raw: { basicInfo: info },
      };
      const trackObj = buildTrack(
        this.context.player,
        item,
        context,
        null,
        this
      );
      return this.createResponse(null, [trackObj]);
    } catch (error) {
      console.error(`[YouTubeExtractor] Handle error: ${error}`);
      return this.createResponse(null, []);
    }
  }

  async stream(track: Track): Promise<ExtractorStreamable> {
    try {
      if (!this.innertube) throw new Error("Innertube not initialized.");

      const videoId = extractVideoId(track.url || (track.raw as any)?.id || "");
      if (!videoId) throw new Error("Unable to extract videoId.");

      // Allow custom stream strategy when provided via options
      if (this._stream) {
        const custom = await this._stream(track);
        if (custom) return custom as ExtractorStreamable;
      }

      const nodeStream = await createSabrStream(videoId);
      if (!nodeStream) throw new Error("Failed to create stream");

      return nodeStream as ExtractorStreamable;
    } catch (error) {
      console.error(`[YouTubeExtractor] Stream error: ${error}`);
      throw error;
    }
  }

  async getRelatedTracks(
    track: Track,
    history: GuildQueueHistory
  ): Promise<ExtractorInfo> {
    if (!this.innertube) throw new Error("Innertube not initialized");

    // Resolve seed video id from track url/raw
    const seedUrl = track.url || (track.raw as any)?.id || "";
    let videoId = extractVideoId(seedUrl);
    if (!videoId)
      throw new Error(
        "[YoutubeExtractor Error] Error at getRelatedTracks(): Unable to extract videoId."
      );

    const info: any = await this.innertube.getInfo(videoId);

    const collectFromFeed = (feed: any): any[] => {
      try {
        if (Array.isArray(feed)) return feed;
        if (Array.isArray(feed?.contents)) return feed.contents;
      } catch {}
      return [];
    };

    // First pass from initial feed
    let feedItems: any[] = collectFromFeed(info.watch_next_feed);

    // If we didn't get much, try to fetch one continuation page
    try {
      if ((info as any).wn_has_continuation && feedItems.length < 5) {
        await info.getWatchNextContinuation();
        feedItems = feedItems.concat(collectFromFeed(info.watch_next_feed));
      }
    } catch {}

    let recommended: YTNodes.LockupView[] = (
      feedItems as unknown as YTNodes.LockupView[]
    ).filter(
      (v) =>
        v?.content_type === "VIDEO" &&
        !history.tracks.some(
          (x) => x.url === `https://youtube.com/watch?v=${v?.content_id}`
        )
    );

    // Fallback: if nothing from watch next, try a lightweight search using title/author
    if (!recommended || recommended.length === 0) {
      try {
        const title = track?.title ?? "";
        const author =
          (track as any)?.author ?? (track as any)?.raw?.author ?? "";
        const query =
          [author, title].filter(Boolean).join(" - ") || title || author;
        const results = await searchYoutubeByQueryName(this.innertube, query);
        const fromSearch = (results?.results ?? []).filter(
          (v: any): v is YTNodes.Video =>
            v?.type === "Video" &&
            !!v?.video_id &&
            !history.tracks.some(
              (x) => x.url === `https://www.youtube.com/watch?v=${v.video_id}`
            )
        );
        recommended = fromSearch as any;
      } catch {}
    }

    if (!recommended || recommended.length === 0) {
      this.context.player.debug("Unable to fetch recommendations.");
      return this.createResponse(null, []);
    }

    // Build tracks from mixed shapes using shared buildTrack
    const seenIds = new Set<string>();
    const trackConstruct: Track[] = [];
    for (const v of recommended) {
      const id =
        (v as any)?.video_id || (v as any)?.id || (v as any)?.content_id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      trackConstruct.push(
        buildTrack(
          this.context.player,
          v,
          { requestedBy: track.requestedBy } as any,
          null,
          this
        )
      );
    }

    return this.createResponse(null, trackConstruct);
  }

  // (Normalization handled in utils.buildTrack)

  // Bridge support: allow other extractors to request a YouTube-backed stream
  async bridge(
    track: Track,
    _sourceExtractor: BaseExtractor | null
  ): Promise<ExtractorStreamable | null> {
    try {
      if (!this.innertube) this.innertube = await getInnertube();

      // Build a base query using extractor-provided strategy if available
      const baseQuery = (() => {
        try {
          const q = this.createBridgeQuery?.(track);
          if (typeof q === "string" && q.trim().length > 0) return q;
        } catch {}
        const title = track?.title ?? "";
        const author =
          (track as any)?.author ?? (track as any)?.raw?.author ?? "";
        return [author, title].filter(Boolean).join(" - ") || title || author;
      })();

      const makeEffectiveQuery = (q: string) => {
        try {
          const lower = (q || "").toLowerCase();
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
          ].some((w) => tokens.has(w));
          const mentionsOfficial =
            lower.includes("official audio") ||
            lower.includes("official video") ||
            tokens.has("official");
          if (!wantsAlt && !mentionsOfficial) return `${q} official audio`;
        } catch {}
        return q;
      };

      const candidates = Array.from(
        new Set([makeEffectiveQuery(baseQuery), baseQuery].filter(Boolean))
      );

      let topVideoId: string | null = null;
      for (const q of candidates) {
        const results = await searchYoutubeByQueryName(this.innertube!, q);
        const first = results?.results
          .filter(
            (v: any): v is YTNodes.Video => v?.type === "Video" && !!v?.video_id
          )
          .at(0);
        if (first?.video_id) {
          topVideoId = first.video_id;
          break;
        }
      }

      if (!topVideoId) return null;

      const nodeStream = await createSabrStream(topVideoId);
      return nodeStream ?? null;
    } catch (error) {
      console.error(`[YouTubeExtractor] Bridge error: ${error}`);
      return null;
    }
  }
}

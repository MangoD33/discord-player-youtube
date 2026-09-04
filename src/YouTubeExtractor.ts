import {
  BaseExtractor,
  GuildQueueHistory,
  Playlist,
  Track,
} from "discord-player";
import type {
  ExtractorInfo,
  ExtractorSearchContext,
  ExtractorStreamable,
  SearchQueryType,
} from "discord-player";
import { Innertube, YTNodes } from "youtubei.js/agnostic";
import type { Types } from "youtubei.js/agnostic";
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
import { createSabrStream } from "./internal/sabr/createSabr.js";
import { createDirectInnertubeStream } from "./internal/directInnertube/createDirectInnertubeStream.js";

export type StreamResolver = "direct-innertube" | "sabr";

const DEFAULT_STREAM_RESOLVER_ORDER: StreamResolver[] = [
  "direct-innertube",
  "sabr",
];

const VARIANT_PENALTIES: Record<string, number> = {
  "8d": 700,
  slowed_reverb: 600,
  nightcore: 600,
  lofi: 500,
  instrumental: 500,
  remix: 400,
  cover: 400,
  live: 300,
  acoustic: 300,
  extended: 200,
};

function normalizeMatchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectVariants(value: string): Set<string> {
  const variants = new Set<string>();
  if (/\b(8d|16d|spatial\s+audio?|binaural|360|surround)\b/.test(value)) variants.add("8d");
  if (/\b(slowed|reverb)\b/.test(value)) variants.add("slowed_reverb");
  if (/\b(nightcore|sped\s?up)\b/.test(value)) variants.add("nightcore");
  if (/\blo\s?fi\b/.test(value)) variants.add("lofi");
  if (/\b(instrumental|karaoke|no\s+vo[ck]als?|backing\s+track)\b/.test(value)) variants.add("instrumental");
  if (/\b(remix|mashup|bootleg|flip|vip\s+mix|reedit)\b/.test(value)) variants.add("remix");
  if (/\b(live\b|in\s+concert|live\s+at|live\s+from)\b/.test(value)) variants.add("live");
  if (/\b(acoustic|unplugged)\b/.test(value)) variants.add("acoustic");
  if (/\bcover\b/.test(value)) variants.add("cover");
  if (/\b(extended\s+(mix|version)|full\s+version)\b/.test(value)) variants.add("extended");
  return variants;
}

export interface ExtractorInitOptions {
  cookie?: string; // YouTube Cookie
  priority?: number; // Extractor priority
  filterAutoplayTracks?: boolean; // Remove tracks if already in history
  innertubeConfigRaw?: Types.InnerTubeConfig; // forwarded to Innertube.create()
  streamResolverOrder?: StreamResolver[]; // Resolver priority, first successful resolver wins
  disableDirectInnertube?: boolean; // Skip the direct InnerTube resolver
  disableSabr?: boolean; // Skip the SABR resolver
}

export class YoutubeExtractor extends BaseExtractor<ExtractorInitOptions> {
  public static identifier: string = "com.mangod33.discord-player-youtube";
  public priority: number = this.options.priority ?? 1;

  private innertube: Innertube | null = null;
  private _stream: Function | null = null;

  async activate(): Promise<void> {
    this.protocols = ["youtube", "yt"];
    const options = (this.options || {}) as ExtractorInitOptions;
    this.getEnabledStreamResolvers();
    this.innertube = await getInnertube(
      options.cookie,
      options.innertubeConfigRaw
    );
    if (options.priority) {
      this.priority = options.priority;
    }
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
        if (!this.innertube) this.innertube = await getInnertube();

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
      // Allow custom stream strategy when provided via options
      if (this._stream) {
        const custom = await this._stream(track);
        if (custom) return custom as ExtractorStreamable;
      }

      const options = this.options as ExtractorInitOptions;
      const videoId = extractVideoId(track.url || (track.raw as any)?.id || "");
      if (!videoId) throw new Error("Unable to extract videoId.");
      return await this.resolveStream(track, videoId, options);
    } catch (error) {
      console.error(`[YouTubeExtractor] Stream error: ${error}`);
      throw error;
    }
  }

  private getEnabledStreamResolvers(): StreamResolver[] {
    const options = (this.options || {}) as ExtractorInitOptions;
    const requestedOrder = options.streamResolverOrder ?? DEFAULT_STREAM_RESOLVER_ORDER;
    const validResolvers = new Set<StreamResolver>(DEFAULT_STREAM_RESOLVER_ORDER);

    if (!Array.isArray(requestedOrder)) {
      throw new TypeError("streamResolverOrder must be an array of resolver names.");
    }
    if (requestedOrder.some((resolver) => !validResolvers.has(resolver))) {
      throw new TypeError(
        "streamResolverOrder may only contain: direct-innertube, sabr."
      );
    }
    if (new Set(requestedOrder).size !== requestedOrder.length) {
      throw new TypeError("streamResolverOrder cannot contain duplicate resolvers.");
    }

    const enabled = requestedOrder.filter((resolver) => {
      return resolver === "direct-innertube"
        ? !options.disableDirectInnertube
        : !options.disableSabr;
    });

    if (!enabled.length) {
      throw new Error(
        "No stream resolvers are enabled. Enable at least one of direct-innertube or sabr."
      );
    }

    return enabled;
  }

  private async resolveStream(
    track: Track,
    videoId: string,
    options: ExtractorInitOptions
  ): Promise<ExtractorStreamable> {
    const resolvers = this.getEnabledStreamResolvers();

    for (const resolver of resolvers) {
      try {
        if (resolver === "direct-innertube") {
          const stream = await createDirectInnertubeStream(videoId);
          if (stream) return stream;
          console.warn(
            "[YouTubeExtractor] direct-innertube returned no stream."
          );
        }

        if (resolver === "sabr") {
          if (!this.innertube) throw new Error("Innertube not initialized.");
          const stream = await createSabrStream(videoId);
          if (stream) return stream as ExtractorStreamable;
          console.warn(
            "[YouTubeExtractor] sabr returned no stream."
          );
        }
      } catch (error) {
        console.warn(`[YouTubeExtractor] ${resolver} resolver failed: ${error}`);
      }
    }

    throw new Error(
      `All configured stream resolvers failed: ${resolvers.join(", ")}.`
    );
  }

  private selectBestBridgeVideo(
    track: Track,
    results: unknown[]
  ): YTNodes.Video | null {
    const title = normalizeMatchText(track.title);
    const author = normalizeMatchText(
      typeof (track as any).author === "string"
        ? (track as any).author
        : (track as any).author?.name ?? (track as any).raw?.author?.name
    );
    const duration = Math.round((track.durationMS ?? 0) / 1000);
    const trackVariants = detectVariants(title);
    let best: YTNodes.Video | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of results) {
      if ((candidate as any)?.type !== "Video" || !(candidate as any)?.video_id) continue;
      const video = candidate as YTNodes.Video;
      if (video.is_live) continue;
      const candidateTitle = normalizeMatchText(video.title?.text);
      const candidateDuration = video.duration?.seconds ?? 0;
      let score = 0;

      if (title && candidateTitle.includes(title)) {
        score += 100;
      } else {
        const words = title.split(/\s+/).filter((word) => word.length > 2);
        if (words.length) {
          score += (words.filter((word) => candidateTitle.includes(word)).length / words.length) * 60;
        }
      }

      if (author && candidateTitle.includes(author)) score += 30;

      const candidateVariants = detectVariants(candidateTitle);
      for (const variant of new Set([...trackVariants, ...candidateVariants])) {
        score += trackVariants.has(variant) === candidateVariants.has(variant)
          ? 15
          : -(VARIANT_PENALTIES[variant] ?? 350);
      }

      if (duration > 0 && candidateDuration > 0) {
        const difference = Math.abs(candidateDuration - duration);
        if (difference <= 4) score += 150;
        else if (difference <= 10) score += 50;
        else if (difference <= 20) score += 10;
        else if (difference <= 40) score -= difference * 3;
        else score -= 500 + difference * 5;
      }

      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }

    return best;
  }

  async getRelatedTracks(
    track: Track,
    history: GuildQueueHistory
  ): Promise<ExtractorInfo> {
    if (!this.innertube) throw new Error("Innertube not initialized");
    const filterFromHistory = this.options.filterAutoplayTracks !== false;

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
        (!filterFromHistory ||
          !history.tracks.some(
            (x) => x.url === `https://youtube.com/watch?v=${v?.content_id}`
          ))
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
            (!filterFromHistory ||
              !history.tracks.some(
                (x) => x.url === `https://www.youtube.com/watch?v=${v.video_id}`
              ))
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
        const best = this.selectBestBridgeVideo(track, results?.results ?? []);
        if (best?.video_id) {
          topVideoId = best.video_id;
          break;
        }
      }

      if (!topVideoId) return null;

      return await this.resolveStream(
        track,
        topVideoId,
        this.options as ExtractorInitOptions
      );
    } catch (error) {
      console.error(`[YouTubeExtractor] Bridge error: ${error}`);
      return null;
    }
  }
}

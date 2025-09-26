let _clientPromise: Promise<any | null> | null = null;
let _disabled = false;
let _authToken: string | undefined;
let _cookieString: string | undefined;
let _poToken: string | undefined;
let _wantPoToken = false;
let _innertubeConfigRaw: unknown;

import Innertube, { UniversalCache, ClientType, YTNodes } from 'youtubei.js';
import {
  msFromDurationLike,
  parseNumber,
  tokenToObject,
  generatePoToken,
  generatePoTokenForInnertube,
  type NormalizedItem,
  type NormalizedResult,
} from './utils.js';

export type YTJSInit = {
  cookie?: string;
  options?: any;
  innertubeConfigRaw?: unknown;
};

export function configureYTJS(
  opts: {
    authentication?: string;
    cookie?: any;
    generateWithPoToken?: boolean;
    innertubeConfigRaw?: unknown;
  } = {}
): void {
  _authToken =
    typeof opts.authentication === 'string' &&
      opts.authentication.trim().length > 0
      ? opts.authentication.trim()
      : undefined;
  _cookieString = toCookieHeader(opts.cookie) ?? _cookieString;
  _innertubeConfigRaw = opts.innertubeConfigRaw;
  _wantPoToken = Boolean(opts.generateWithPoToken);
  if (_wantPoToken && !_poToken) {
    try {
      _poToken = generatePoToken();
    } catch {
      /* ignore */
    }
  }
}

async function createClient(init: YTJSInit): Promise<any | null> {
  try {
    const InnertubeCtor: any = Innertube as unknown as any;
    if (!InnertubeCtor) return null;

    const payload: any = {};
    const tokenString: string | undefined = _authToken;
    const cacheDir: string | undefined = (process as any)?.env?.YT_CACHE_DIR;
    const configuredCookie = cookieHeader();
    const rawConfig = init?.innertubeConfigRaw ?? _innertubeConfigRaw;
    const createInnertube = rawConfig != null
      ? (payload: any) => InnertubeCtor.create(payload, rawConfig)
      : (payload: any) => InnertubeCtor.create(payload);

    if (tokenString) {
      // Prefer TV OAuth client when tokens are provided
      if (ClientType as any)
        payload.client_type = (ClientType as any).TV_EMBEDDED;
      if (UniversalCache as any)
        payload.cache = new (UniversalCache as any)(true, cacheDir);
      if (configuredCookie) payload.cookie = configuredCookie;
      if (_poToken) payload.po_token = _poToken;

      const client = await createInnertube(payload);

      try {
        const tokens = tokenToObject(tokenString);
        await client.session.signIn(tokens);
        // Best-effort info logging (avoid bringing a logger dependency)
        try {
          const info = await client.account.getInfo();
          // eslint-disable-next-line no-console
          console.info(
            info.contents?.contents
              ? `[discord-player-youtube] Signed into YouTube using the name: ${info.contents.contents[0].is(YTNodes.AccountItem)
                ? info.contents.contents[0].as(YTNodes.AccountItem)
                  .account_name.text ?? 'UNKNOWN ACCOUNT'
                : 'UNKNOWN ACCOUNT'
              }`
              : `[discord-player-youtube] Signed into YouTube using the client name: ${client.session.client_name}@${client.yt.session.client_version}`
          );
        } catch { }
      } catch (err: any) {
        // If token parsing/sign-in fails, continue with unsigned client
        try {
          // eslint-disable-next-line no-console
          console.warn(
            `YouTubeExtractor: TV OAuth sign-in failed; continuing unsigned. Reason: ${String(
              err?.message || err
            )}`
          );
        } catch { }
      }

      // Optionally improve PoToken after client is available (has visitorData)
      // Always attempt improvement when requested; replace fallback token if a better one is generated.
      if (_wantPoToken) {
        try {
          const pot = await generatePoTokenForInnertube(client);
          if (pot && typeof pot === 'string') {
            _poToken = pot;
            try {
              if (client?.session) {
                client.session.po_token = pot;
                if (client.session.player) client.session.player.po_token = pot;
              }
            } catch { }
          }
        } catch { }
      }
      return client;
    }

    // Cookie-based or anonymous client
    if (init?.cookie) payload.cookie = init.cookie;
    else if (configuredCookie) payload.cookie = configuredCookie;
    if (init?.options && typeof init.options === 'object')
      Object.assign(payload, init.options);
    if (_poToken) payload.po_token = _poToken;
    const client = await createInnertube(payload);
    if (_wantPoToken) {
      try {
        const pot = await generatePoTokenForInnertube(client);
        if (pot && typeof pot === 'string') {
          _poToken = pot;
          try {
            if (client?.session) {
              client.session.po_token = pot;
              if (client.session.player) client.session.player.po_token = pot;
            }
          } catch { }
        }
      } catch { }
    }
    return client;
  } catch {
    return null;
  }
}

export async function getYTJSClient(init: YTJSInit = {}): Promise<any | null> {
  if (_disabled) return null;
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const client = await createClient(init);
    if (!client) _disabled = true;
    return client;
  })();
  return _clientPromise;
}

export function disableYTJS() {
  _disabled = true;
}

export function isYTJSEnabled(): boolean {
  return !_disabled;
}

export async function streamUrl(
  url: string,
  cookie?: string,
  useClient?: string
): Promise<string> {
  const vid: string | null = extractVideoIdFromAny(url);
  const client = await getYTJSClient({
    cookie: cookie ?? cookieHeader(),
    options: {},
  });
  if (!client || !vid) throw new Error('YTJS_UNAVAILABLE');

  // Preferred: youtubei.js-deciphered URL
  try {
    const fmt: any = await (client as any).getStreamingData(vid, {
      type: 'audio',
      quality: 'best',
      client: useClient || 'ANDROID',
    });
    if (fmt?.url) return String(fmt.url);
  } catch {
    /* ignore and try fallback */
  }

  // Fallback: chooseFormat + decipher
  try {
    const info: any = await (client as any).getInfo(vid, {
      client: useClient || 'ANDROID',
    });
    if (typeof info?.chooseFormat === 'function') {
      const fmt: any = info.chooseFormat({ type: 'audio', quality: 'best' });
      const u =
        typeof fmt?.decipher === 'function'
          ? fmt.decipher((client as any).session?.player)
          : fmt?.url;
      if (u) return String(u);
    }
    // Last resort: raw URL from streaming_data (may fail for ciphered entries)
    const sd: any =
      (info as any).streaming_data ||
      (info as any).player_response?.streamingData;
    const formats: any[] = ([] as any[])
      .concat(sd?.adaptive_formats || [])
      .concat(sd?.formats || []);
    const audioOnly = formats.filter(
      (f: any) =>
        (!f.height && !f.width) ||
        f?.vcodec === 'none' ||
        (f?.has_audio && !f?.has_video)
    );
    const best = audioOnly.sort(
      (a: any, b: any) =>
        Number(b?.bitrate || b?.audioBitrate || 0) -
        Number(a?.bitrate || a?.audioBitrate || 0)
    )[0];
    if (best?.url) return String(best.url);
  } catch {
    /* ignore */
  }

  throw new Error('YTJS_NO_STREAM');
}

// ===== Helpers specific to youtubei.js structures
function textFromRuns(obj: any): string | undefined {
  try {
    const runs = obj?.runs as any[] | undefined;
    if (runs?.length) return String(runs.map((r) => r.text).join(''));
    const simple = obj?.simpleText;
    if (simple) return String(simple);
  } catch { }
  return undefined;
}
function thumbFromThumbs(t: any): string | undefined {
  try {
    const thumbs = t?.thumbnails as any[] | undefined;
    if (Array.isArray(thumbs) && thumbs.length)
      return String(
        thumbs.sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0].url
      );
  } catch { }
  return undefined;
}

// Local cookie + URL helpers (use only cookie provided at registration)

function toCookieHeader(input: any): string | undefined {
  try {
    if (!input) return undefined;
    if (typeof input === 'string') return input.trim() || undefined;
    // Tough-cookie CookieJar support
    if (typeof input?.getCookieStringSync === 'function') {
      const v = input.getCookieStringSync('https://www.youtube.com');
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    if (typeof input?.jar?.getCookieStringSync === 'function') {
      const v = input.jar.getCookieStringSync('https://www.youtube.com');
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    // Array of cookie-like objects
    if (Array.isArray(input)) {
      const parts = input
        .map((c: any) => {
          if (!c) return '';
          const name = (c.name ?? c.key ?? '').toString();
          const value = (c.value ?? '').toString();
          if (name && value) return `${name}=${value}`;
          if (typeof c.toString === 'function') {
            const s = String(c.toString());
            if (s.includes('=')) return s;
          }
          return '';
        })
        .filter(Boolean);
      const joined = parts.join('; ').trim();
      return joined || undefined;
    }
    // Object map of name -> value
    if (typeof input === 'object') {
      const parts = Object.entries(input)
        .map(([k, v]) => (k && v ? `${k}=${v}` : ''))
        .filter(Boolean);
      const joined = parts.join('; ').trim();
      return joined || undefined;
    }
  } catch { }
  return undefined;
}

function cookieHeader(): string | undefined {
  return _cookieString;
}

function extractVideoIdFromAny(href: string): string | null {
  // Try robust URL parsing first
  try {
    const u = new URL(href);
    // Short links: https://youtu.be/<id>
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) {
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg && seg.length >= 8) return seg;
    }
    // Watch links: https://www.youtube.com/watch?v=<id>
    const v = u.searchParams.get('v');
    if (v && v.trim().length >= 8) return v.trim();
    // Shorts: https://www.youtube.com/shorts/<id>
    const m = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{8,})/);
    if (m) return m[1];
  } catch { }
  // Fallback: loose ID pattern (best-effort)
  const m = href.match(/([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ===== Provider-specific exported functions (moved from utils)
export async function ytjsSearch(
  query: string,
  options: any
): Promise<NormalizedResult | null> {
  const client = await getYTJSClient({ cookie: cookieHeader() });
  if (!client) return null;
  try {
    const limit = Math.min(options?.limit ?? 25, 25);
    let search: any = await client.search(query);

    let vids: any[] = Array.isArray(search?.videos) ? [...search.videos] : [];

    // If fewer than requested, try to fetch continuation pages
    while (vids.length < limit) {
      try {
        if (typeof search?.getContinuation !== 'function') break;
        const next: any = await search.getContinuation();
        if (!next) break;
        search = next;
        const more: any[] = Array.isArray(search?.videos) ? search.videos : [];
        if (!more.length) break;
        vids = vids.concat(more);
      } catch {
        break;
      }
    }

    const items: NormalizedItem[] = vids.slice(0, limit).map((v) => {
      const title =
        typeof v.title?.toString === 'function'
          ? v.title.toString()
          : v.title || 'Unknown';
      const author =
        v.author?.name ||
        (typeof v.author?.toString === 'function'
          ? v.author.toString()
          : 'Unknown');
      const durationLike =
        typeof v.length_text?.toString === 'function'
          ? v.length_text.toString()
          : v.duration?.toString?.() || '0:00';
      const thumb =
        Array.isArray(v.thumbnails) && v.thumbnails.length
          ? String(
            v.thumbnails.sort(
              (a: any, b: any) => (b.width || 0) - (a.width || 0)
            )[0].url
          )
          : undefined;
      return {
        source: 'youtube',
        url: `https://youtu.be/${(v as any).video_id || (v as any).id}`,
        title: title || 'Unknown',
        author: author || 'Unknown',
        durationMS: msFromDurationLike(durationLike),
        thumbnail: thumb,
        isLive: !v.length_text && !v.duration,
        views: parseNumber((v as any).view_count),
        raw: v,
      } as NormalizedItem;
    });
    return { playlist: null, items };
  } catch {
    return null;
  }
}

export async function ytjsResolvePlaylist(
  playlistId: string,
  url: string
): Promise<NormalizedResult | null> {
  const client = await getYTJSClient({ cookie: cookieHeader() });
  if (!client) return null;
  try {
    const resp: any = await client.actions.execute('/browse', {
      browseId: `VL${playlistId}`,
    });
    const root: any = resp?.data || {};
    const plroot: any =
      root?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer
        ?.contents?.[0]?.playlistVideoListRenderer;
    const contents: any[] = plroot?.contents || [];
    const items: NormalizedItem[] = [];
    for (const c of contents) {
      const v = (c as any).playlistVideoRenderer;
      if (!v?.videoId) continue;
      const title = textFromRuns(v.title) || 'Unknown';
      const author =
        textFromRuns(v.shortBylineText) ||
        textFromRuns(v.longBylineText) ||
        'Unknown';
      const duration = textFromRuns(v.lengthText) || '0:00';
      const thumbnail = thumbFromThumbs(v.thumbnail);
      items.push({
        source: 'youtube',
        url: `https://youtu.be/${v.videoId}`,
        title,
        author,
        durationMS: msFromDurationLike(duration),
        thumbnail,
        isLive: !v.lengthText,
        playlistId,
        raw: v,
      });
    }
    if (!items.length) return null;
    return {
      playlist: {
        id: playlistId,
        title: undefined,
        url: `https://www.youtube.com/playlist?list=${playlistId}`,
        thumbnail: items[0]?.thumbnail,
      },
      items,
    };
  } catch {
    return null;
  }
}

export async function ytjsResolveMix(
  url: string,
  playlistId: string
): Promise<NormalizedResult | null> {
  const client = await getYTJSClient({ cookie: cookieHeader() });
  if (!client) return null;
  const videoId = extractVideoIdFromAny(url);
  if (!videoId) return null;
  try {
    const resp: any = await client.actions.execute('/next', {
      videoId,
      playlistId,
    });
    const root: any = resp?.data || {};
    const playlist =
      root?.contents?.twoColumnWatchNextResults?.playlist?.playlist;
    const contents: any[] = playlist?.contents || [];
    const items: NormalizedItem[] = [];
    for (const c of contents) {
      const v = (c as any).playlistPanelVideoRenderer;
      if (!v?.videoId) continue;
      const title = textFromRuns(v.title) || 'Unknown';
      const author =
        textFromRuns(v.shortBylineText) ||
        textFromRuns(v.longBylineText) ||
        'Unknown';
      const duration = textFromRuns(v.lengthText) || '0:00';
      const thumbnail = thumbFromThumbs(v.thumbnail);
      items.push({
        source: 'youtube',
        url: `https://youtu.be/${v.videoId}`,
        title,
        author,
        durationMS: msFromDurationLike(duration),
        thumbnail,
        isLive: !v.lengthText,
        playlistId,
        playlistTitle: textFromRuns(playlist?.title) || 'YouTube Mix',
        raw: v,
      });
    }
    if (!items.length) return null;
    return {
      playlist: {
        id: playlistId,
        title: textFromRuns(playlist?.title) || 'YouTube Mix',
        url: `https://youtu.be/${videoId}&list=${playlistId}`,
        thumbnail: items[0]?.thumbnail,
      },
      items,
    };
  } catch {
    return null;
  }
}

export async function ytjsResolveVideo(
  url: string
): Promise<NormalizedResult | null> {
  const client = await getYTJSClient({ cookie: cookieHeader() });
  if (!client) return null;
  try {
    const vid = extractVideoIdFromAny(url);
    if (!vid) return null;
    const info: any = await client.getInfo(vid);
    const b = info?.basic_info || {};
    const thumb =
      Array.isArray(b.thumbnail?.thumbnails) && b.thumbnail.thumbnails.length
        ? String(
          b.thumbnail.thumbnails.sort(
            (a: any, b: any) => (b.width || 0) - (a.width || 0)
          )[0].url
        )
        : undefined;
    const item: NormalizedItem = {
      source: 'youtube',
      url: `https://youtu.be/${b.id}`,
      title: b.title ?? 'Unknown',
      author:
        typeof b.author === 'string' ? b.author : b.channel?.name || 'Unknown',
      durationMS: msFromDurationLike(String(b.duration ?? 0)),
      thumbnail: thumb,
      isLive: Boolean(b.is_live),
      views: parseNumber((b as any).view_count),
      likes: parseNumber((b as any).like_count),
      raw: { info },
    };
    return { playlist: null, items: [item] };
  } catch {
    return null;
  }
}

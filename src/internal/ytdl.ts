import core from "@distube/ytdl-core";
import { clone, toSecond, parseNumber, type NormalizedItem, type NormalizedResult } from "./utils.js";

export type Cookie = core.Cookie;
export type getInfoOptions = core.getInfoOptions;

let _cookies: core.Cookie[] | undefined;
let _options: core.getInfoOptions = {};
let _agent: ReturnType<typeof core.createAgent> | undefined;

export function configure(opts: { cookies?: core.Cookie[]; ytdlOptions?: core.getInfoOptions } = {}) {
  _cookies = opts.cookies ? clone(opts.cookies) : undefined;
  _options = opts.ytdlOptions ? clone(opts.ytdlOptions) : {};
  _agent = core.createAgent(_cookies);
  _options.agent = _agent;
}

export function ensureAgent() {
  if (!_options.agent) {
    _agent = core.createAgent(_cookies);
    _options.agent = _agent;
  }
}

export function cookieHeader(): string {
  const agent = _options.agent as any;
  if (!agent?.jar) return "";
  return agent.jar.getCookieStringSync?.("https://www.youtube.com") ?? "";
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const cookie = cookieHeader();
  if (cookie) headers["cookie"] = cookie;
  return headers;
}

export function mergedOptions(): core.getInfoOptions {
  const base: core.getInfoOptions = { ..._options };
  const h = authHeaders();
  base.requestOptions = { ...(base.requestOptions || {}), headers: { ...(base.requestOptions?.headers as any || {}), ...h } } as any;
  if (_options.agent) base.agent = _options.agent;
  return base;
}

export const validateURL = core.validateURL;
export const getVideoID = core.getVideoID;

export async function getBasicInfo(url: string, opts?: core.getInfoOptions): Promise<any> {
  return core.getBasicInfo(url, opts ?? mergedOptions());
}

export async function getInfo(url: string, opts?: core.getInfoOptions): Promise<any> {
  return core.getInfo(url, opts ?? mergedOptions());
}

export async function streamUrl(url: string): Promise<string> {
  let target = url;
  if (!core.validateURL(target)) {
    try { const vid = core.getVideoID(target); target = `https://youtu.be/${vid}`; } catch { throw new Error('CANNOT_RESOLVE_SONG'); }
  }

  let info: any;
  try {
    info = await core.getInfo(target, mergedOptions());
  } catch (e) {
    try {
      const base: any = { ...mergedOptions() };
      (base as any).playerClients = ['WEB'] as any;
      info = await core.getInfo(target, base);
    } catch {
      throw e;
    }
  }
  if (!info.formats?.length) throw new Error('UNAVAILABLE_VIDEO');
  const details = info.videoDetails as any;
  const isLive: boolean = Boolean(details?.isLive);
  const format = info.formats
    .filter((f: any) => f.hasAudio && (!isLive || f.isHLS))
    .sort((a: any, b: any) => Number(b.audioBitrate) - Number(a.audioBitrate) || Number(a.bitrate) - Number(b.bitrate))[0];
  if (!format) throw new Error('UNPLAYABLE_FORMATS');
  return String(format.url);
}

export async function ytdlResolveVideo(url: string): Promise<NormalizedResult | null> {
  try {
    let target = url;
    if (!validateURL(target)) {
      try { const vid = getVideoID(target); target = `https://youtu.be/${vid}`; } catch { }
    }
    let info: any;
    try {
      info = await getBasicInfo(target, mergedOptions());
    } catch (e) {
      const base: any = { ...mergedOptions() };
      (base as any).playerClients = ['WEB'] as any;
      info = await getBasicInfo(target, base);
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
      raw: { chapters: (d as any).chapters ?? [], storyboards: (d as any).storyboards ?? [], related: info.related_videos ?? [], info }
    };
    return { playlist: null, items: [item] };
  } catch { return null; }
}

// Convenience API to keep callers clean
export const api = {
  init: configure,
  ensure: ensureAgent,
  cookie: cookieHeader,
  headers: authHeaders,
  options: mergedOptions,
  validateURL,
  getVideoID,
  getBasicInfo,
  getInfo,
  streamUrl,
  ytdlResolveVideo,
};

export default api;

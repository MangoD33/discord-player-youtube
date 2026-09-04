import { Readable } from "node:stream";

const CONFIG_TTL_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const FALLBACK_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

interface YoutubeClient {
  name: string;
  id: string;
  version: string;
  userAgent: string;
  context: Record<string, unknown>;
  priority: number;
}

interface YoutubeConfig {
  apiKey: string;
  visitorData?: string;
  fetchedAt: number;
}

interface AudioCandidate {
  url: string;
  userAgent: string;
  score: number;
  hasNParam: boolean;
  containerPreference: number;
  clientPriority: number;
}

const CLIENTS: YoutubeClient[] = [
  {
    name: "visionOS",
    id: "101",
    version: "1.02",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    context: {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471",
      hl: "en",
      gl: "US",
    },
    priority: 0,
  },
  {
    name: "Android",
    id: "3",
    version: "20.10.35",
    userAgent: "com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip",
    context: {
      clientName: "ANDROID",
      clientVersion: "20.10.35",
      osName: "Android",
      osVersion: "14",
      platform: "MOBILE",
      androidSdkVersion: 34,
      hl: "en",
      gl: "US",
    },
    priority: 1,
  },
  {
    name: "iOS",
    id: "5",
    version: "20.10.1",
    userAgent:
      "com.google.ios.youtube/20.10.1 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)",
    context: {
      clientName: "IOS",
      clientVersion: "20.10.1",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "17.4.0.21E219",
      platform: "MOBILE",
      hl: "en",
      gl: "US",
    },
    priority: 2,
  },
];

let config: YoutubeConfig | null = null;

function timeoutSignal(timeout = REQUEST_TIMEOUT_MS): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function getConfig(forceRefresh = false): Promise<YoutubeConfig> {
  if (!forceRefresh && config && Date.now() - config.fetchedAt < CONFIG_TTL_MS) return config;

  let apiKey = FALLBACK_API_KEY;
  let visitorData: string | undefined;
  const request = timeoutSignal();
  try {
    const response = await fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=en", {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: request.signal,
    });
    if (response.ok) {
      const body = await response.text();
      apiKey = body.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? apiKey;
      visitorData = body.match(/"VISITOR_DATA":"([^"]+)"/)?.[1]?.replace(/\\u0026/g, "&");
    }
  } finally {
    request.clear();
  }

  config = { apiKey, visitorData, fetchedAt: Date.now() };
  return config;
}

function headersFor(client: YoutubeClient, currentConfig: YoutubeConfig): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
    "User-Agent": client.userAgent,
    "X-YouTube-Client-Name": client.id,
    "X-YouTube-Client-Version": client.version,
    ...(currentConfig.visitorData
      ? { "X-Goog-Visitor-Id": currentConfig.visitorData }
      : {}),
  };
}

function usableUrl(format: Record<string, unknown>): string | null {
  if (typeof format.url === "string" && format.url) return format.url;
  const cipher = typeof format.signatureCipher === "string"
    ? format.signatureCipher
    : typeof format.cipher === "string"
      ? format.cipher
      : null;
  if (!cipher) return null;

  const params = new URLSearchParams(cipher);
  const url = params.get("url");
  const signature = params.get("sig") ?? params.get("signature");
  if (!url) return null;
  if (!signature) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${params.get("sp") ?? "sig"}=${encodeURIComponent(signature)}`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

async function playerResponse(
  videoId: string,
  client: YoutubeClient,
  currentConfig: YoutubeConfig
): Promise<Record<string, unknown>> {
  const request = timeoutSignal();
  try {
    const response = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(currentConfig.apiKey)}`,
      {
        method: "POST",
        headers: headersFor(client, currentConfig),
        body: JSON.stringify({
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          context: { client: client.context },
          playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
        }),
        signal: request.signal,
      }
    );
    if (!response.ok) throw new Error(`${client.name}: player API HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    request.clear();
  }
}

async function isReachable(url: string, userAgent: string): Promise<boolean> {
  const request = timeoutSignal(1_500);
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-0", "User-Agent": userAgent, "Accept-Language": "en-US,en;q=0.9" },
      signal: request.signal,
    });
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  } finally {
    request.clear();
  }
}

async function resolveReachableUrl(
  url: string,
  userAgent: string
): Promise<string | null> {
  const uri = new URL(url);
  if (!uri.hostname.endsWith("googlevideo.com")) {
    return (await isReachable(url, userAgent)) ? url : null;
  }

  const servers = uri.searchParams
    .get("mn")
    ?.split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (!servers || servers.length < 2) {
    return (await isReachable(url, userAgent)) ? url : null;
  }

  const candidates = Array.from(
    new Set([
      url,
      ...servers.map((server, index) => {
        const host = uri.hostname
          .replace(/^rr\d+---/, `rr${index + 1}---`)
          .replace(/sn-[a-z0-9]+-[a-z0-9]+/, server);
        const alternative = new URL(url);
        alternative.hostname = host;
        return alternative.toString();
      }),
    ])
  );

  try {
    return await Promise.any(
      candidates.map(async (candidate) => {
        if (await isReachable(candidate, userAgent)) return candidate;
        throw new Error("CDN node is unavailable.");
      })
    );
  } catch {
    return null;
  }
}

function createResumableStream(url: string, userAgent: string): Readable {
  const stream = (async function* () {
    let offset = 0;
    let resumeAttempts = 0;

    while (true) {
      const headers: HeadersInit = {
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      };
      if (offset > 0) headers.Range = `bytes=${offset}-`;

      let response: Response;
      try {
        response = await fetch(url, { headers });
      } catch (error) {
        if (resumeAttempts++ >= 3) throw error;
        console.warn(
          `[DirectInnertube] Audio connection interrupted; resuming from byte ${offset}.`
        );
        continue;
      }

      if (!response.ok || !response.body) {
        throw new Error(`Audio request: HTTP ${response.status} ${response.statusText}`);
      }

      try {
        for await (const chunk of response.body as any) {
          const buffer = Buffer.from(chunk);
          offset += buffer.length;
          yield buffer;
        }
        return;
      } catch (error) {
        if (resumeAttempts++ >= 3) throw error;
        console.warn(
          `[DirectInnertube] Audio connection interrupted; resuming from byte ${offset}.`
        );
      }
    }
  })();

  return Readable.from(stream);
}

export async function createDirectInnertubeStream(
  videoId: string
): Promise<Readable | null> {
  let currentConfig = await getConfig();
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidates: AudioCandidate[] = [];
    let loginRequired = 0;

    for (const client of CLIENTS) {
      try {
        const player = await playerResponse(videoId, client, currentConfig);
        const status = (player.playabilityStatus as Record<string, unknown> | undefined)?.status;
        if (status === "LOGIN_REQUIRED") {
          loginRequired++;
          continue;
        }
        if (status && status !== "OK") continue;
        const streamingData = player.streamingData as Record<string, unknown> | undefined;
        const formats = [
          ...((streamingData?.adaptiveFormats as unknown[]) ?? []),
          ...((streamingData?.formats as unknown[]) ?? []),
        ];
        for (const rawFormat of formats) {
          if (!rawFormat || typeof rawFormat !== "object" || Array.isArray(rawFormat)) continue;
          const format = rawFormat as Record<string, unknown>;
          const mimeType = String(format.mimeType ?? "").toLowerCase();
          const isAdaptive = ((streamingData?.adaptiveFormats as unknown[]) ?? []).includes(rawFormat);
          if (isAdaptive && !mimeType.includes("audio/")) continue;
          const url = usableUrl(format);
          if (!url) continue;
          candidates.push({
            url,
            userAgent: client.userAgent,
            score: isAdaptive
              ? numberValue(format.bitrate ?? format.averageBitrate) * 1_000_000 + numberValue(format.audioSampleRate)
              : numberValue(format.bitrate ?? format.averageBitrate),
            hasNParam: new URL(url).searchParams.has("n"),
            containerPreference: mimeType.includes("webm") ? 1 : 0,
            clientPriority: client.priority,
          });
        }
      } catch (error) {
        // Try the remaining InnerTube clients before reporting a resolver failure.
      }
    }

    if (loginRequired === CLIENTS.length && attempt === 0) {
      config = null;
      currentConfig = await getConfig(true);
      continue;
    }

    candidates.sort((a, b) =>
      b.score - a.score ||
      Number(a.hasNParam) - Number(b.hasNParam) ||
      a.containerPreference - b.containerPreference ||
      a.clientPriority - b.clientPriority
    );
    for (const candidate of candidates) {
      const url = await resolveReachableUrl(candidate.url, candidate.userAgent);
      if (!url) continue;
      return createResumableStream(url, candidate.userAgent);
    }
    return null;
  }
  return null;
}

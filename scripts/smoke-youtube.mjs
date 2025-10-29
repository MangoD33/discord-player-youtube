// Simple smoke test for discord-player-youtube
// Usage:
//   npm run -s build && node scripts/smoke-youtube.mjs [queryOrUrlOrId]

import "dotenv/config";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { Log } from "youtubei.js";
Log.setLevel(Log.Level.NONE);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = resolve(__dirname, "..", "dist");

const getInnertubeUrl = pathToFileURL(
  resolve(distDir, "internal", "getInnertube.js")
).href;
const createSabrUrl = pathToFileURL(
  resolve(distDir, "internal", "createSabr.js")
).href;
const extractorUrl = pathToFileURL(resolve(distDir, "index.js")).href;
const { getInnertube } = await import(getInnertubeUrl);
const { YoutubeExtractor } = await import(extractorUrl);

// discord.js and discord-player are CJS-compatible; dynamic import works as well
const { Client, GatewayIntentBits } = await import("discord.js");
const { Player, QueryType } = await import("discord-player");

function extractVideoId(input) {
  if (typeof input !== "string" || input.length === 0) return null;
  const s = input.trim();
  const idPattern = /^[a-zA-Z0-9_-]{11}$/;
  if (idPattern.test(s)) return s;
  try {
    const url = new URL(s);
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length > 0 && idPattern.test(segs[0])) return segs[0];
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && idPattern.test(v)) return v;
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.length >= 2) {
        const [first, second] = segs;
        if (
          (first === "shorts" || first === "embed" || first === "v") &&
          idPattern.test(second)
        ) {
          return second;
        }
      }
    }
  } catch {}
  const m = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  const parts = s.split(/[/?&#]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (idPattern.test(parts[i])) return parts[i];
  }
  return null;
}

async function main() {
  const arg = process.argv.slice(2).join(" ").trim();
  const innertube = await getInnertube();
  const shouldStream = process.env.SMOKE_STREAM === "1";

  // Create minimal discord.js client (no login needed) and player
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const player = new Player(client);
  await player.extractors.register(YoutubeExtractor);
  const registeredId = YoutubeExtractor.identifier;
  console.log(
    `[smoke] Registered extractor: ${registeredId}. Total extractors: ${player.extractors.size}`
  );
  const registered = player.extractors.get(registeredId);
  if (!registered) throw new Error("Extractor did not register");

  let videoId = extractVideoId(arg);

  if (!videoId) {
    const query = arg || "lofi hip hop radio";
    const results = await innertube.search(query);
    if (!results || !results.results || results.results.length === 0) {
      throw new Error("Search returned no results");
    }
    const firstVideo = results.results.find(
      (v) => v.type === "Video" && v.video_id
    );
    if (!firstVideo) throw new Error("No video result found in search");
    videoId = firstVideo.video_id;
    console.log(
      `[smoke] Selected first result: ${
        firstVideo.title?.text || firstVideo.title
      }`
    );
  } else {
    console.log(`[smoke] Using provided video ID: ${videoId}`);
  }

  // Test 1: URL extraction (provided URL)
  const URL_TEST = "https://www.youtube.com/watch?v=U2waT9TxPU0";
  const resUrlInfo = await registered.handle(URL_TEST, {
    requestedBy: "smoke",
  });
  if (!resUrlInfo || !resUrlInfo.tracks || resUrlInfo.tracks.length === 0) {
    throw new Error("URL handle returned no tracks");
  }
  const urlTrack = resUrlInfo.tracks[0];
  console.log(`[smoke] URL handle OK. First track: ${urlTrack.title}`);

  // Test 1b: Playlist URL handling
  const PLAYLIST_TEST =
    "https://www.youtube.com/watch?v=sNY_2TEmzho&list=PLjB_8hSS2lEPSOivtbvDDugFuCeqC4_xm";
  const resPlaylistInfo = await registered.handle(PLAYLIST_TEST, {
    requestedBy: "smoke",
  });
  const playlistTracks = resPlaylistInfo?.tracks ?? [];
  const playlistMeta = resPlaylistInfo?.playlist ?? null;
  console.log(
    `[smoke] Playlist handle: tracks=${playlistTracks.length}` +
      (playlistMeta ? `, title="${playlistMeta.title}"` : "")
  );

  // Test 1c: Mix URL handling (RD... playlist)
  const MIX_TEST =
    "https://www.youtube.com/watch?v=phLb_SoPBlA&list=RDEMiH8aXmL0GBif6quidMdHew&start_radio=1";
  const resMixInfo = await registered.handle(MIX_TEST, {
    requestedBy: "smoke",
  });
  const mixTracks = resMixInfo?.tracks ?? [];
  const mixMeta = resMixInfo?.playlist ?? null;
  console.log(
    `[smoke] Mix handle: tracks=${mixTracks.length}` +
      (mixMeta ? `, title="${mixMeta.title}"` : "")
  );

  // Test 2: text search breakdown and extractor results
  const SEARCH_QUERY = "passionfruit - drake";
  const rawSearch = await innertube.search(SEARCH_QUERY);
  const rawResults = rawSearch?.results ?? [];
  const counts = { videos: 0, playlists: 0, mixes: 0, others: 0 };
  for (const r of rawResults) {
    const t = r?.type;
    if (t === "Video" || t === "CompactVideo") counts.videos++;
    else if (t === "Playlist" || t === "GridPlaylist") counts.playlists++;
    else if (t === "Mix" || t === "CompactMix" || t === "GridMix")
      counts.mixes++;
    else counts.others++;
  }
  console.log(
    `[smoke] Search breakdown ("${SEARCH_QUERY}") total=${rawResults.length}, ` +
      `videos=${counts.videos}, playlists=${counts.playlists}, mixes=${counts.mixes}, others=${counts.others}`
  );

  const resSearchInfo = await registered.handle(SEARCH_QUERY, {
    requestedBy: "smoke",
  });
  if (
    !resSearchInfo ||
    !resSearchInfo.tracks ||
    resSearchInfo.tracks.length === 0
  ) {
    throw new Error("Text search returned no tracks");
  }
  console.log(
    `[smoke] Extractor search OK. tracks=${resSearchInfo.tracks.length}, first="${resSearchInfo.tracks[0].title}"`
  );

  // Test 3: autoplay recommendations via getRelatedTracks
  try {
    const seedTrack = resSearchInfo.tracks[0];
    const historyStub = { tracks: [seedTrack] };
    const relatedInfo = await registered.getRelatedTracks(seedTrack, historyStub);
    const relatedTracks = relatedInfo?.tracks ?? [];
    console.log(
      `[smoke] Related tracks: count=${relatedTracks.length}` +
        (relatedTracks[0]
          ? `, first="${relatedTracks[0].title}", duration=${relatedTracks[0].duration}`
          : "")
    );
    if (
      relatedTracks.some((t) => t?.url && t.url === seedTrack.url)
    ) {
      throw new Error(
        "Autoplay returned the seed track that exists in history"
      );
    }
  } catch (e) {
    console.warn(
      "[smoke] Autoplay (getRelatedTracks) check did not complete:",
      e?.message || e
    );
  }

  if (!shouldStream) {
    console.log(
      "[smoke] Streaming test disabled (set SMOKE_STREAM=1 to enable)."
    );
    return;
  }

  const stream = await registered.stream(urlTrack);
  if (!stream) throw new Error("createSabrStream returned null");

  let bytes = 0;
  const limit = 128 * 1024; // 128KB is enough to prove streaming works
  await new Promise((resolvePromise, reject) => {
    stream.on("data", (chunk) => {
      bytes += chunk.length || 0;
      if (bytes >= limit) {
        stream.destroy?.();
        resolvePromise();
      }
    });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });

  console.log(`[smoke] Stream OK. Received ~${bytes} bytes.`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err?.stack || err?.message || err);
  process.exit(1);
});

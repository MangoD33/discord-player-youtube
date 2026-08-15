import {
  SabrPlaybackOptions,
  SabrStream,
  SabrStreamConfig,
} from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import { Readable } from "node:stream";
import { getInnertube } from "./getInnertube.js";
import { getWebPoMinter, invalidateWebPoMinter } from "./tokenGenerator.js";
import { Constants, YTNodes } from "youtubei.js/agnostic";
import { SabrFormat } from "googlevideo/shared-types";

const DEFAULT_OPTIONS: SabrPlaybackOptions = {
  audioQuality: "MEDIUM",
  enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
  preferH264: true,
};

function toNodeReadable(stream: any): Readable | null {
  if (!stream) return null;
  if (typeof stream.pipe === "function") return stream;
  if (typeof (stream.getReader === "function")) {
    const reader = stream.getReader();
    const iterable = (async function* () {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock?.();
      }
    })();
    return Readable.from(iterable);
  }
  if (Symbol.asyncIterator in stream) return Readable.from(stream);
  throw new TypeError("Unsupported stream type from SABR");
}

export async function createSabrStream(
  videoId: string,
  sabrOptions?: SabrPlaybackOptions
): Promise<Readable | null> {
  const innertube = await getInnertube();
  let contentPoToken: string;

  try {
    const minter = await getWebPoMinter(innertube);
    contentPoToken = await minter.mint(videoId);
  } catch (error) {
    console.warn(
      `[SabrStream] Initial WebPoMinter failed: ${error}. Retrying with fresh BotGuard...`
    );
    invalidateWebPoMinter();
    const minter = await getWebPoMinter(innertube, { forceRefresh: true });
    contentPoToken = await minter.mint(videoId);
  }

  const watchEndpoint = new YTNodes.NavigationEndpoint({
    watchEndpoint: { videoId },
  });
  const playerResponse = await watchEndpoint.call(innertube.actions, {
    playbackContext: {
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: "-1",
        signatureTimestamp: innertube.session.player?.signature_timestamp,
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
    serviceIntegrityDimensions: { poToken: contentPoToken },
    parse: true,
  });

  const serverAbrStreamingUrl = await innertube.session.player?.decipher(
    playerResponse.streaming_data?.server_abr_streaming_url
  );
  const videoPlaybackUstreamerConfig =
    playerResponse.player_config?.media_common_config
      .media_ustreamer_request_config?.video_playback_ustreamer_config;

  if (!videoPlaybackUstreamerConfig)
    throw new Error("ustreamerConfig not found");
  if (!serverAbrStreamingUrl)
    throw new Error("serverAbrStreamingUrl not found");

  const sabrFormats: SabrFormat[] =
    playerResponse.streaming_data?.adaptive_formats.map(buildSabrFormat) || [];

  const SabrStreamConfig: SabrStreamConfig = {
    fetch: innertube.session.http.fetch_function,
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    poToken: contentPoToken,
    clientInfo: {
      clientName: parseInt(
        (Constants.CLIENT_NAME_IDS as any)[
          innertube.session.context.client.clientName as any
        ] as unknown as string
      ),
      clientVersion: innertube.session.context.client.clientVersion,
    },
  };
  const serverAbrStream = new SabrStream(SabrStreamConfig);

  let lastStatus: number | null = null;
  let poTokenRotation: Promise<void> | null = null;
  serverAbrStream.on(
    "streamProtectionStatusUpdate",
    async (statusUpdate: any) => {
      if (statusUpdate.status !== lastStatus) {
        lastStatus = statusUpdate.status;
        console.debug(
          `[SabrStream] Stream protection status: ${statusUpdate.status}`
        );
      }
      // SPS 2 ("attestation pending") is a non-fatal, often-repeated status
      // that the server may resend on every response during normal
      // throttling — it does not mean the current token was rejected, so
      // rotating on it just spams BotGuard for no benefit. Only SPS 3
      // ("attestation required") means the token was actually rejected and
      // needs a fresh mint.
      if (statusUpdate.status === 3) {
        if (poTokenRotation) return;

        poTokenRotation = (async () => {
          try {
            console.warn(
              "[SabrStream] Token rejected by stream protection (SPS 3). Resetting Botguard and rotating token..."
            );
            invalidateWebPoMinter();

            let rotationMinter = await getWebPoMinter(innertube, {
              forceRefresh: true,
            });

            try {
              const newToken = await rotationMinter.mint(videoId);
              serverAbrStream.setPoToken(newToken);
              console.debug("[SabrStream] PoToken refreshed (SPS 3).");
            } catch {
              invalidateWebPoMinter();
              rotationMinter = await getWebPoMinter(innertube, {
                forceRefresh: true,
              });
              const fallbackToken = await rotationMinter.mint(videoId);
              serverAbrStream.setPoToken(fallbackToken);
              console.debug(
                "[SabrStream] PoToken refreshed after rebuilding Botguard."
              );
            }
          } catch (error) {
            console.error(`Failed to rotate PoToken: ${error}`);
          } finally {
            poTokenRotation = null;
          }
        })();
      }
    }
  );

  const playbackOptions: SabrPlaybackOptions = {
    ...DEFAULT_OPTIONS,
    ...sabrOptions,
  };
  const { audioStream } = await serverAbrStream.start(playbackOptions);
  const nodeStream = toNodeReadable(audioStream);

  return nodeStream;
}

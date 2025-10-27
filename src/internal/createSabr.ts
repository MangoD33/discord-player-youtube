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
  videoId: string
): Promise<Readable | null> {
  const innertube = await getInnertube();
  let accountInfo = null;

  try {
    accountInfo = await innertube.account.getInfo();
  } catch (error) {
    throw error;
  }
  const dataSyncId =
    accountInfo?.contents?.contents[0]?.endpoint?.payload?.supportedTokens?.[2]
      ?.datasyncIdToken?.datasyncIdToken ??
    innertube.session.context.client.visitorData;
  const minter = await getWebPoMinter(innertube);
  const contentPoToken = await minter.mint(videoId);
  const poToken = await minter.mint(dataSyncId);

  const watchEndpoint = new YTNodes.NavigationEndpoint({
    watchEndpoint: { videoId },
  });
  const playerResponse = await watchEndpoint.call(innertube.actions, {
    playbackContext: {
      adPlaybackContext: { pyv: true },
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
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    poToken: poToken,
    clientInfo: {
      clientName: parseInt(
        Constants.CLIENT_NAME_IDS[
          innertube.session.context.client
            .clientName as keyof typeof Constants.CLIENT_NAME_IDS
        ] as unknown as string
      ),
      clientVersion: innertube.session.context.client.clientVersion,
    },
  };
  const serverAbrStream = new SabrStream(SabrStreamConfig);

  let protectionFailureCount = 0;
  let lastStatus: number | null = null;
  serverAbrStream.on(
    "streamProtectionStatusUpdate",
    async (statusUpdate: any) => {
      if (statusUpdate.status !== lastStatus) lastStatus = statusUpdate.status;
      if (statusUpdate.status === 2) {
        protectionFailureCount = Math.min(protectionFailureCount + 1, 10);

        try {
          const rotationMinter = await getWebPoMinter(innertube, {
            forceRefresh: protectionFailureCount >= 3,
          });
          const placeholderToken = rotationMinter.generatePlaceholder(videoId);
          serverAbrStream.setPoToken(placeholderToken);
          const mintedPoToken = await rotationMinter.mint(videoId);
          serverAbrStream.setPoToken(mintedPoToken);
        } catch (error) {
          if (protectionFailureCount === 1 || protectionFailureCount % 5 === 0)
            console.error(`Failed to rotate PoToken: ${error}`);
        }
      } else if (statusUpdate.status === 3) {
        console.error(
          "Stream protection rejected token (SPS 3). Resetting Botguard."
        );
        invalidateWebPoMinter();
      } else {
        protectionFailureCount = 0;
      }
    }
  );

  // serverAbrStream.on("error", (error: Error) => {
  //     console.error("SABR stream error:", error);
  // });

  const { audioStream } = await serverAbrStream.start(DEFAULT_OPTIONS);
  const nodeStream = toNodeReadable(audioStream);

  return nodeStream;
}

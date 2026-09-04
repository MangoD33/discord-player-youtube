import type { Readable } from "node:stream";
import { createSabrStream as createSimpleSabrStream } from "simple-ytdl-core";
import { getInnertube } from "../getInnertube.js";

export async function createSabrStream(videoId: string): Promise<Readable | null> {
  const innertube = await getInnertube();
  return (await createSimpleSabrStream(innertube as any, videoId)) as Readable;
}

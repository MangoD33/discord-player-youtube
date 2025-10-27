import dotenv from "dotenv";
import { Innertube, UniversalCache, Platform } from "youtubei.js";
import type { Types } from "youtubei.js/web";

Platform.shim.eval = async (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>
) => {
  const properties = [];
  if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  const code = `${data.output}\nreturn { ${properties.join(", ")} }`;
  return new Function(code)();
};

dotenv.config();

let innertubeInstance: Innertube | undefined;

export async function getInnertube(): Promise<Innertube> {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create({
      cache: new UniversalCache(false),
      cookie: process.env.YOUTUBE_COOKIE ?? undefined,
    });
  }
  return innertubeInstance;
}

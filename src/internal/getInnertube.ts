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
  if (innertubeInstance) return innertubeInstance;

  const rawCookie = (process.env.YOUTUBE_COOKIE ?? "").trim();
  const hasCookie = rawCookie.length > 0;

  // Helper to validate if the provided cookie actually works for auth-only endpoints
  const validateCookie = async (tube: Innertube): Promise<boolean> => {
    try {
      // Account info should only be available when truly authenticated.
      await tube.account.getInfo();
      return true;
    } catch (err) {
      return false;
    }
  };

  if (hasCookie) {
    try {
      const withCookie = await Innertube.create({
        cache: new UniversalCache(false),
        cookie: rawCookie,
      });

      const valid = await validateCookie(withCookie);
      if (valid) {
        console.log("[YouTube Extractor] Authenticated via provided cookie.");
        innertubeInstance = withCookie;
        return innertubeInstance;
      }

      console.warn(
        "[YouTube Extractor] Provided cookie appears invalid. Falling back to unauthenticated session."
      );
    } catch (error) {
      console.warn(
        `[YouTube Extractor] Failed to initialize authenticated session (cookie). Falling back unauthenticated. Error: ${error}`
      );
    }
  } else {
    console.warn(
      "[YouTube Extractor] No cookie found. Using unauthenticated session."
    );
  }

  // Fallback: no cookie or invalid cookie
  innertubeInstance = await Innertube.create({
    cache: new UniversalCache(false),
  });
  return innertubeInstance;
}

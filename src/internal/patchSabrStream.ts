import { SabrStream } from "googlevideo/sabr-stream";

// googlevideo@4.1.1's SabrStream.fetchAndProcessSegments() treats a
// legitimate server-side throttle response (STREAM_PROTECTION_STATUS >= 2,
// carrying NEXT_REQUEST_POLICY, but no MEDIA part yet) as a hard error. That
// error is retried through executeWithRetry's short fixed backoff ladder
// (500ms-8000ms) instead of the server's requested backoffTimeMs, burning
// through all 10 retries in ~50-60s and killing streams that are otherwise
// healthy. The only way this specific error can be thrown is after at least
// one UMP part was already parsed successfully (an earlier check throws a
// different error if none were), so it is always a throttle response, never
// a transport failure - safe to swallow. The stream's own stall detection
// (30s x 5 stalls) remains the real safety net if the server genuinely stops
// responding. See: https://github.com/LuanRT/GoogleVideo/blob/main/src/core/SabrStream.ts
const THROTTLE_ERROR_MESSAGE =
  "No media parts or protocol updates received from server.";
const PATCHED = Symbol.for(
  "discord-player-youtube.sabrStreamThrottlePatch"
);

export function patchSabrStreamThrottleBug(): void {
  const proto = SabrStream.prototype as unknown as Record<PropertyKey, any>;
  if (proto[PATCHED]) return;

  const original = proto.fetchAndProcessSegments;
  if (typeof original !== "function") return;

  proto.fetchAndProcessSegments = async function patchedFetchAndProcessSegments(
    ...args: unknown[]
  ) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      if (error instanceof Error && error.message === THROTTLE_ERROR_MESSAGE) {
        return;
      }
      throw error;
    }
  };

  proto[PATCHED] = true;
}

import { run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

export const DETACH_RETRY_DELAYS_MS = [0, 500, 2_000];

/**
 * `hdiutil detach` fails while anything still holds the volume, which on a desktop is routinely
 * Spotlight indexing the image it has just seen appear. Retry before giving up.
 *
 * Returns the last failure rather than throwing it. The caller runs this from a `finally`, where a
 * throw replaces whatever went wrong inside the block and skips the cleanup after it, leaving the
 * image attached with no explanation of why.
 */
export async function detachQuietly(mountRoot, options = {}) {
  const detach = options.detach ?? (root => run(SYSTEM_TOOLS.hdiutil, ["detach", root]));
  const delaysMs = options.delaysMs ?? DETACH_RETRY_DELAYS_MS;
  let failure = null;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      await detach(mountRoot);
      return null;
    } catch (error) {
      failure = error;
    }
  }
  return failure;
}

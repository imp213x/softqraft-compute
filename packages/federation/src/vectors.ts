/**
 * Loads the vectors file that ships with the package.
 *
 * This is the only module that touches the file system, and it does so
 * through a dynamic `import("node:fs/promises")` inside the function, so
 * importing the package never loads `node:fs`. Services that bundle or
 * relocate the vectors pass the JSON to `parseVectors` instead.
 */

import { parseVectors, type FederationVectors } from "./conformance.js";

export const VECTORS_FILE = "cloud-federation-v1.vectors.json";

/** URL of the bundled vectors file, resolved relative to this module (`../vectors/`). */
export function bundledVectorsUrl(): URL {
  return new URL(`../vectors/${VECTORS_FILE}`, import.meta.url);
}

/** Read and parse the bundled vectors, or the file at `location` when given. */
export async function loadBundledVectors(location?: string | URL): Promise<FederationVectors> {
  const { readFile } = await import("node:fs/promises");
  return parseVectors(await readFile(location ?? bundledVectorsUrl()));
}

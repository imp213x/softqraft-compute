/**
 * @softqraft/federation: the SoftQraft Service Federation kit
 * (cloud-federation-v1, including the F5 §8 and §9 additions).
 *
 * The package decides what is valid; each service decides how to store and
 * serve it.
 */

export * from "./contract.js";
export * from "./signing.js";
export * from "./verify.js";
export * from "./grants.js";
export * from "./paths.js";
export * from "./sessions.js";
export * from "./roles.js";
export * from "./descriptor.js";
export * from "./conformance.js";
export * from "./vectors.js";

/** Package version; VENDORED.json records the same value. */
export const PACKAGE_VERSION = "1.0.0";

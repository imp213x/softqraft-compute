/** The pages' HTTP client: same origin, session cookie, JSON in and out. */
import { ApiError } from "./shared/errors.js";

/**
 * @param {{ fetcher?: typeof fetch }} [options]
 */
export function createApi({ fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [init]
   */
  return async function api(path, { method = "GET", body, headers = {} } = {}) {
    const sent = { Accept: "application/json", ...headers };
    if (body !== undefined) sent["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetcher(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: sent,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError({ status: 0 });
    }
    if (res.status === 204) return {};
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new ApiError({ status: res.ok ? 502 : res.status });
    }
    if (!res.ok) throw new ApiError({ status: res.status, code: data?.error?.code });
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError({ status: 502 });
    return data;
  };
}

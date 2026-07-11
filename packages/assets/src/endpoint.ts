import { AssetError } from "./error";

/**
 * Canonical, non-secret identity for a provider endpoint. Credentials, query parameters, and
 * fragments are prohibited because request hashes and provenance sidecars must be safe to persist.
 */
export function sanitizeEndpointIdentity(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AssetError("invalid-request");
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AssetError("invalid-request");
  }

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

/** Returns true only when a value is already a safe, canonical endpoint identity. */
export function isCanonicalEndpointIdentity(endpoint: string): boolean {
  try {
    return sanitizeEndpointIdentity(endpoint) === endpoint;
  } catch {
    return false;
  }
}

/**
 * Compares two already-canonical, redacted endpoint identities. Unsafe or merely canonicalizable
 * input is rejected instead of normalized, so callers never need to retain an original URL.
 */
export function sameCanonicalEndpointIdentity(left: string, right: string): boolean {
  return isCanonicalEndpointIdentity(left) && isCanonicalEndpointIdentity(right) && left === right;
}

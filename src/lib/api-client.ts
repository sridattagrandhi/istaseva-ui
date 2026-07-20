import type { ServiceResult } from "@/types/domain";
import { frontendConfig } from "@/config/frontend";
import { getAuthProvider } from "@/config/providers";

/** Resolved API base URL — starts as the configured value, updated if a fallback port works. */
let resolvedApiUrl: string | null = null;

const _isLocalhost = (() => {
  try {
    const h = new URL(frontendConfig.apiUrl).hostname;
    return h === "localhost" || h === "127.0.0.1";
  } catch { return false; }
})();

/** Build fallback ports: configured port, then +1, +2 (localhost-only dev feature) */
const _configuredPort = (() => {
  try { return Number(new URL(frontendConfig.apiUrl).port) || 3001; } catch { return 3001; }
})();
const FALLBACK_PORTS = [_configuredPort, _configuredPort + 1, _configuredPort + 2];

async function discoverApiUrl(): Promise<string> {
  if (resolvedApiUrl) return resolvedApiUrl;

  // For non-localhost URLs (staging/prod), skip port probing — use as-is.
  if (!_isLocalhost) {
    resolvedApiUrl = frontendConfig.apiUrl;
    return resolvedApiUrl;
  }

  // Try the configured URL first
  try {
    const resp = await fetch(`${frontendConfig.apiUrl}/health`, { method: "GET", signal: AbortSignal.timeout(1500) });
    if (resp.ok) {
      resolvedApiUrl = frontendConfig.apiUrl;
      return resolvedApiUrl;
    }
  } catch { /* fall through */ }

  // Try fallback ports
  const base = new URL(frontendConfig.apiUrl);
  for (const port of FALLBACK_PORTS) {
    if (String(port) === base.port) continue; // already tried
    const candidate = `${base.protocol}//${base.hostname}:${port}`;
    try {
      const resp = await fetch(`${candidate}/health`, { method: "GET", signal: AbortSignal.timeout(1500) });
      if (resp.ok) {
        resolvedApiUrl = candidate;
        console.info(`[api-client] API discovered on fallback port ${port}`);
        return resolvedApiUrl;
      }
    } catch { /* try next */ }
  }

  // Nothing reachable — fall back to configured URL and let requests fail normally
  resolvedApiUrl = frontendConfig.apiUrl;
  return resolvedApiUrl;
}

export async function getAccessToken() {
  if (frontendConfig.authProvider === "firebase") {
    const session = await getAuthProvider().getSession();
    return session?.accessToken || "";
  }

  return (
    localStorage.getItem("cognito_access_token") || ""
  );
}

export function getJsonHeaders(includeContentType = true): Record<string, string> {
  return {
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
  };
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<ServiceResult<T>> {
  try {
    const apiUrl = await discoverApiUrl();
    const token = await getAccessToken();
    const headers = new Headers(init?.headers || {});

    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        success: false,
        error: data.error?.message || data.message || "API request failed",
        code: data.error?.code,
        errorDetails: data.error?.details,
      };
    }

    return {
      success: true,
      data: data as T,
    };
  } catch (error: any) {
    // If the request failed, reset discovery so next request retries
    resolvedApiUrl = null;
    return {
      success: false,
      error: error?.message || "Network request failed",
    };
  }
}

/**
 * Authenticated GET that returns the response body as a Blob — used for the
 * tax-invoice PDF download. Reuses the same Bearer token + URL discovery as
 * `apiRequest` so localhost dev port-probing keeps working. Throws a typed
 * Error on non-2xx so callers can show a toast.
 */
export async function fetchAuthenticatedBlob(path: string): Promise<Blob> {
  const apiUrl = await discoverApiUrl();
  const token = await getAccessToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${apiUrl}${path}`, { method: "GET", headers });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const j = await response.json();
      detail = j?.error?.message || j?.message || detail;
    } catch { /* not JSON, use status */ }
    throw new Error(`Download failed: ${detail}`);
  }
  return await response.blob();
}

/**
 * Triggers a browser download for an authenticated server endpoint that
 * returns a binary file (currently only the booking tax-invoice PDF). Saves
 * with the supplied filename. Used by every dashboard's "Download invoice"
 * button so all callers go through the SAME server-rendered tax invoice —
 * the legacy client-side renderer in `src/lib/invoice.ts` is intentionally
 * deprecated for booking invoices.
 */
export async function downloadAuthenticatedFile(path: string, filename: string): Promise<void> {
  const blob = await fetchAuthenticatedBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke a tick later so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

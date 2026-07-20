import axios, { AxiosInstance } from "axios";
import { auth } from "./firebase";
import { config } from "./config";

export const api: AxiosInstance = axios.create({
  baseURL: config.apiBaseUrl,
  timeout: 20000,
});

api.interceptors.request.use(async (req) => {
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    req.headers = req.headers ?? {};
    req.headers.Authorization = `Bearer ${token}`;
  }
  return req;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Backend AppError shape is { error: { message, code, details } }. Read the
    // nested message, and preserve code + details (e.g. LISTING_NOT_READY's
    // `missing[]`) so callers can render specific fix-it prompts instead of a
    // generic "Request failed" string.
    const data = err?.response?.data;
    const apiErr = data?.error ?? data ?? {};
    const message = apiErr.message ?? err.message ?? "Network error";
    const e = new Error(message) as Error & { code?: string; details?: any };
    e.code = apiErr.code;
    e.details = apiErr.details;
    return Promise.reject(e);
  }
);

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function apiCall<T>(fn: () => Promise<{ data: T }>): Promise<ApiResult<T>> {
  try {
    const res = await fn();
    return { ok: true, data: res.data };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "Unknown error" };
  }
}

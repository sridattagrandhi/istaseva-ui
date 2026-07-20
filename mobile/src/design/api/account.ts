// design/api/account.ts — DSAR export + account deletion (PRIV-002 / LEG-017).
// Mirror of the web AccountPrivacyPanel data layer (mobile shares no code
// with web). Endpoints: /api/users/me/export, /api/users/me/deletion-request.
import { api } from "@/lib/api";

export type AccountRequestStatus = "requested" | "processing" | "completed" | "failed" | "cancelled";

export type AccountRequestState = {
  id: string;
  type: "export" | "deletion";
  status: AccountRequestStatus;
  requestedAt: string;
  completedAt: string | null;
  /** Deletion only: when the erase job may run (end of the 48h grace window). */
  scheduledFor?: string | null;
  /** Deletion only: true while the request can still be cancelled. */
  cancellable?: boolean;
  error: string | null;
  downloadUrl?: string | null;
  downloadExpiresAt?: string | null;
};

/** Start (or return the in-flight) data export. */
export async function requestExport(): Promise<AccountRequestState> {
  const res = await api.post("/api/users/me/export");
  return res.data?.data;
}

/** Latest export request; includes a fresh downloadUrl while the bundle lives. */
export async function fetchExportStatus(): Promise<AccountRequestState | null> {
  const res = await api.get("/api/users/me/export");
  return res.data?.data ?? null;
}

/**
 * Schedule account deletion. Requires a recent sign-in — the server returns
 * 401 REAUTH_REQUIRED on a stale session; callers should ask the user to
 * sign in again and retry. Erasure runs after a 48h grace window; the
 * account stays usable until then and the request can be cancelled.
 */
export async function requestDeletion(): Promise<AccountRequestState> {
  const res = await api.post("/api/users/me/deletion-request");
  return res.data?.data;
}

/** Latest deletion request (pending grace-window one included), if any. */
export async function fetchDeletionStatus(): Promise<AccountRequestState | null> {
  const res = await api.get("/api/users/me/deletion-request");
  return res.data?.data ?? null;
}

/** Cancel the open deletion request during its grace window. */
export async function cancelDeletion(): Promise<AccountRequestState> {
  const res = await api.post("/api/users/me/deletion-request/cancel");
  return res.data?.data;
}

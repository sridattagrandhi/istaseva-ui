// design/api/storage.ts — proxy-upload local files to S3 via the backend.
// Generalizes the proven KYC upload pattern (api/verification.ts): POST the raw
// bytes to /api/storage/upload with x-upload-bucket / x-upload-key headers; the
// server validates the key is owned by the caller (must contain their uid as a
// path segment), writes to S3 (or local in dev), and returns a CDN publicUrl.
import { api } from "@/lib/api";

const ALLOWED = /^(image\/(jpeg|png|webp)|application\/pdf)$/;

/**
 * Upload one local file uri and return its public (CDN) URL. Already-remote
 * https urls pass through untouched so callers can safely re-submit a mix of
 * existing + newly-picked photos.
 *
 * @param userId Firebase uid — MUST be the authenticated user; it is embedded
 *   in the storage key so the server's ownership check passes.
 */
export async function uploadToStorage(params: {
  userId: string;
  uri: string;
  bucket: string;
  keyPrefix?: string; // logical folder under the user, e.g. "listings"
  mimeType?: string;
  /** Admin assisted-onboarding: upload FOR this user. The key is scoped to
   *  their uid and the role-gated `x-upload-target-user` header is sent, so
   *  the photos live where the host's own uploads would. */
  adminTargetUserId?: string;
}): Promise<string> {
  if (/^https?:\/\//i.test(params.uri)) return params.uri; // already on S3/CDN

  const mime = params.mimeType && ALLOWED.test(params.mimeType) ? params.mimeType : "image/jpeg";
  const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1];
  const prefix = params.keyPrefix ? `${params.keyPrefix}/` : "";
  const rand = Math.random().toString(36).slice(2, 8);
  // Admin uploads scope the key to the TARGET user; self-uploads to the caller.
  const owner = params.adminTargetUserId ?? params.userId;
  const key = `${owner}/${prefix}${Date.now()}_${rand}.${ext}`;

  const blob = await (await fetch(params.uri)).blob();
  const up = await api.post("/api/storage/upload", blob, {
    headers: {
      "Content-Type": mime,
      "x-upload-bucket": params.bucket,
      "x-upload-key": key,
      ...(params.adminTargetUserId ? { "x-upload-target-user": params.adminTargetUserId } : {}),
    },
    transformRequest: [(d) => d], // keep axios from JSON-stringifying the blob
  });
  const publicUrl: string = up.data?.publicUrl ?? up.data?.data?.publicUrl;
  if (!publicUrl) throw new Error("Upload failed: no file url returned");
  return publicUrl;
}

/**
 * Upload a list of listing photo uris to the `listing-images` bucket, in order.
 * Pass-through entries (already-https) keep their position. Sequential on
 * purpose — mobile networks choke on many parallel multipart uploads.
 */
export async function uploadListingPhotos(userId: string, uris: string[], adminTargetUserId?: string): Promise<string[]> {
  const out: string[] = [];
  for (const uri of uris) {
    out.push(await uploadToStorage({ userId, uri, bucket: "listing-images", keyPrefix: "listings", adminTargetUserId }));
  }
  return out;
}

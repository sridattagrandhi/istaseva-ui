// design/api/verification.ts — KYC document upload + status (Phase 4).
// Mirrors the web flow (src/domains/verification/verification.service.ts):
//   1. proxy-upload the file bytes to /api/storage/upload (bypasses S3 CORS),
//   2. record the document at /api/verification/documents with the returned publicUrl.
import { api } from "@/lib/api";

export type KycDoc = {
  id: string;
  type: string;
  number?: string | null;
  fileUrl: string;
  status: "pending" | "approved" | "rejected" | string;
  rejectionReason?: string | null;
};

function mapDoc(d: any): KycDoc {
  return {
    id: d.id,
    type: d.document_type,
    number: d.document_number ?? null,
    fileUrl: d.file_url,
    status: d.status,
    rejectionReason: d.rejection_reason ?? null,
  };
}

const ALLOWED = /^(image\/(jpeg|png|webp)|application\/pdf)$/;

/** Upload a picked file (local uri) and record it as a verification document. */
export async function uploadKycDocument(params: {
  userId: string; // Firebase uid — must equal req.user.id so the storage key passes ownership check
  documentType: string;
  uri: string;
  mimeType?: string;
  documentNumber?: string;
}): Promise<KycDoc> {
  const mime = params.mimeType && ALLOWED.test(params.mimeType) ? params.mimeType : "image/jpeg";
  const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1];
  // Storage key must include the authenticated user's id as a path segment.
  const key = `${params.userId}/${Date.now()}_${params.documentType}.${ext}`;

  // 1. Read the local file into a blob and proxy-upload the raw bytes.
  const fileResp = await fetch(params.uri);
  const blob = await fileResp.blob();
  const up = await api.post("/api/storage/upload", blob, {
    headers: {
      "Content-Type": mime,
      "x-upload-bucket": "verification-documents",
      "x-upload-key": key,
    },
    transformRequest: [(d) => d], // keep axios from JSON-stringifying the blob
  });
  const publicUrl: string = up.data?.publicUrl ?? up.data?.data?.publicUrl;
  if (!publicUrl) throw new Error("Upload failed: no file url returned");

  // 2. Record the document against the user.
  const rec = await api.post("/api/verification/documents", {
    document_type: params.documentType,
    document_number: params.documentNumber || undefined,
    file_url: publicUrl,
  });
  return mapDoc(rec.data?.data ?? rec.data);
}

export async function fetchKycDocuments(): Promise<KycDoc[]> {
  const res = await api.get("/api/verification/documents");
  const items = res.data?.data ?? res.data ?? [];
  return (Array.isArray(items) ? items : []).map(mapDoc);
}

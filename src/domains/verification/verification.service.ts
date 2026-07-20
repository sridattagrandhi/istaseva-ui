/**
 * Verification Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import type { ServiceResult, UUID, VerificationDocument } from "@/types/domain";

export class VerificationService {
  async uploadDocument(params: {
    userId: UUID;
    documentType: string;
    documentNumber?: string;
    file: File;
  }): Promise<ServiceResult<VerificationDocument>> {
    // Key must include the authenticated user's id as a path segment so the
    // server can verify the caller owns the object they're writing.
    const key = buildUploadKey(params.userId, params.file.name);

    // Use server-side proxy upload to avoid S3 CORS issues
    const { getAccessToken } = await import("@/lib/api-client");
    const token = await getAccessToken();
    const uploadResponse = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/storage/upload`, {
      method: "POST",
      headers: {
        "Content-Type": params.file.type,
        "x-upload-bucket": "verification-documents",
        "x-upload-key": key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: params.file,
    });

    if (!uploadResponse.ok) {
      const err = await uploadResponse.json().catch(() => ({}));
      const msg = typeof err.error === "string" ? err.error : err.error?.message || err.message || "Failed to upload document file";
      return { success: false, error: msg };
    }

    const uploadResult = await uploadResponse.json();

    const recordResult = await apiRequest<{ data: any }>("/api/verification/documents", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        document_type: params.documentType,
        document_number: params.documentNumber,
        file_url: uploadResult.publicUrl,
      }),
    });

    if (!recordResult.success || !recordResult.data) {
      return { success: false, error: recordResult.error };
    }

    return { success: true, data: this.mapDocument(recordResult.data.data) };
  }

  async getDocuments(): Promise<ServiceResult<VerificationDocument[]>> {
    const result = await apiRequest<{ data: any[] }>(`/api/verification/documents`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapDocument) };
  }

  private mapDocument(row: any): VerificationDocument {
    return {
      id: row.id,
      userId: row.user_id,
      documentType: row.document_type,
      documentNumber: row.document_number,
      fileUrl: row.file_url,
      status: row.status,
      rejectionReason: row.rejection_reason,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
    };
  }
}

let _instance: VerificationService | null = null;
export function getVerificationService(): VerificationService {
  if (!_instance) _instance = new VerificationService();
  return _instance;
}

export interface VerifyDocumentRequest {
  providerId: string;
  documentType: string;
  documentNumber?: string;
  fileUrl: string;
}

/**
 * Future implementations:
 * - DigiLocker
 * - Aadhaar / PAN verification vendors
 * - Manual-review workflows
 */
export interface IKycProvider {
  verifyDocument(params: VerifyDocumentRequest): Promise<Record<string, unknown>>;
}

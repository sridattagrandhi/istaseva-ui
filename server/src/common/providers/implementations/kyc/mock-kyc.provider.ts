import type { IKycProvider, VerifyDocumentRequest } from '../../interfaces/kyc-provider.interface.js';

export class MockKycProvider implements IKycProvider {
  async verifyDocument(params: VerifyDocumentRequest): Promise<Record<string, unknown>> {
    // Mock provider auto-approves all documents.
    // In production, swap for a real KYC provider (DigiLocker, etc.) that
    // performs actual verification and returns the real status.
    return {
      verified: true,
      providerId: params.providerId,
      documentType: params.documentType,
      documentNumber: params.documentNumber,
      riskScore: 0.1,
      status: 'approved',
    };
  }
}

export const mockKycProvider = new MockKycProvider();

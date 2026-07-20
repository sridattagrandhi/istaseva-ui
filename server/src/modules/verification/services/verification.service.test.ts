// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listDocumentsForUser = vi.fn();
const createDocument = vi.fn();
const updateDocumentStatus = vi.fn();
const updateUserVerificationStatus = vi.fn();
const countApprovedDocumentsForUser = vi.fn();
const verifyDocument = vi.fn();

vi.mock('../repositories/verification.repository.js', () => ({
  verificationRepository: {
    listDocumentsForUser,
    createDocument,
    updateDocumentStatus,
    updateUserVerificationStatus,
    countApprovedDocumentsForUser,
  },
}));

vi.mock('../../../common/providers/registry.js', () => ({
  getKycProvider: vi.fn(async () => ({
    verifyDocument,
  })),
}));

describe('VerificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDocumentsForUser.mockResolvedValue({ rows: [] });
    updateDocumentStatus.mockResolvedValue({ rows: [{ id: 'doc-1', status: 'approved' }] });
    updateUserVerificationStatus.mockResolvedValue({ rows: [] });
    countApprovedDocumentsForUser.mockResolvedValue({ rows: [{ count: '0' }] });
  });

  it('creates a pending verification document keyed by user_id and starts KYC verification', async () => {
    createDocument.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', status: 'pending', user_id: 'user-1' }],
    });

    const { verificationService } = await import('./verification.service.js');
    const result = await verificationService.createDocument('user-1', {
      document_type: 'aadhaar',
      document_number: '1234',
      file_url: 'https://files/doc.pdf',
    });

    expect(result.data.status).toBe('pending');
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        document_type: 'aadhaar',
      }),
    );
  });

  it('updates the user-level verification status to verified when KYC auto-approves (no provider profile needed)', async () => {
    createDocument.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', status: 'pending', user_id: 'user-1' }],
    });
    verifyDocument.mockResolvedValueOnce({ status: 'approved', verified: true });

    // After the doc is approved, the in-service re-listing should show one
    // approved doc and no pending docs, which flips the user to 'verified'.
    listDocumentsForUser.mockResolvedValue({
      rows: [{ id: 'doc-1', document_type: 'aadhaar', status: 'approved' }],
    });

    const { verificationService } = await import('./verification.service.js');
    await verificationService.createDocument('user-1', {
      document_type: 'aadhaar',
      file_url: 'https://files/doc.pdf',
    });

    // Async KYC chain runs in the background — give it a few macrotask
    // flushes so the entire chain (verifyDocument → updateDocumentStatus →
    // listDocumentsForUser → updateUserVerificationStatus) completes.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(updateDocumentStatus).toHaveBeenCalledWith('doc-1', 'approved', undefined);
    expect(updateUserVerificationStatus).toHaveBeenCalledWith('user-1', 'verified');
  });
});

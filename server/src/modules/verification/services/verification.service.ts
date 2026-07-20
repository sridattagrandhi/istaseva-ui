import { getKycProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';
import { verificationRepository } from '../repositories/verification.repository.js';

export class VerificationService {
  async listDocuments(userId: string) {
    const result = await verificationRepository.listDocumentsForUser(userId);
    return { data: result.rows };
  }

  async createDocument(userId: string, payload: {
    document_type: string;
    document_number?: string;
    file_url: string;
  }) {
    const result = await verificationRepository.createDocument({
      user_id: userId,
      document_type: payload.document_type,
      document_number: payload.document_number,
      file_url: payload.file_url,
    });
    const document = result.rows[0];

    // Fire async KYC verification and process the result.
    void this.processKycVerification(document.id, userId, payload).catch((err) => {
      logger.error('KYC verification processing failed', { documentId: document.id, error: err.message });
    });

    return { data: document };
  }

  /**
   * Runs the KYC provider check and updates document + user statuses.
   * Currently auto-approves in mock mode; will perform real checks in production.
   */
  private async processKycVerification(
    documentId: string,
    userId: string,
    payload: { document_type: string; document_number?: string; file_url: string },
  ) {
    const kycProvider = await getKycProvider();
    const kycResult = await kycProvider.verifyDocument({
      providerId: userId, // KYC provider interface unchanged; pass userId as the subject id
      documentType: payload.document_type,
      documentNumber: payload.document_number,
      fileUrl: payload.file_url,
    });

    const status = kycResult.status === 'approved' || kycResult.verified === true
      ? 'approved'
      : kycResult.status === 'rejected'
        ? 'rejected'
        : 'pending';

    const rejectionReason = status === 'rejected'
      ? (kycResult.reason as string) || 'Document could not be verified'
      : undefined;

    await verificationRepository.updateDocumentStatus(documentId, status, rejectionReason);

    logger.info('KYC document verification processed', {
      documentId,
      userId,
      status,
      documentType: payload.document_type,
    });

    await this.evaluateUserVerification(userId);
  }

  /**
   * Re-evaluate the user's overall verification status from the current set
   * of documents. Verified once any approved document exists and nothing is
   * still pending; rejected only when every doc was rejected.
   */
  private async evaluateUserVerification(userId: string) {
    const docs = await verificationRepository.listDocumentsForUser(userId);
    const allDocs = docs.rows;

    if (allDocs.length === 0) return;

    const approved = allDocs.filter((d) => (d as { status: string }).status === 'approved');
    const rejected = allDocs.filter((d) => (d as { status: string }).status === 'rejected');
    const pending = allDocs.filter((d) => (d as { status: string }).status === 'pending');

    let userStatus: string;
    if (approved.length > 0 && pending.length === 0) {
      userStatus = 'verified';
    } else if (rejected.length > 0 && approved.length === 0 && pending.length === 0) {
      userStatus = 'rejected';
    } else if (allDocs.length > 0) {
      userStatus = 'submitted';
    } else {
      userStatus = 'pending';
    }

    await verificationRepository.updateUserVerificationStatus(userId, userStatus);

    logger.info('User verification status updated', {
      userId,
      status: userStatus,
      approvedCount: approved.length,
      rejectedCount: rejected.length,
      pendingCount: pending.length,
    });
  }

  async getUserVerificationStatus(userId: string) {
    const docs = await verificationRepository.listDocumentsForUser(userId);
    const approvedCount = await verificationRepository.countApprovedDocumentsForUser(userId);
    return {
      documents: docs.rows,
      approvedCount: parseInt(approvedCount.rows[0]?.count || '0', 10),
      totalCount: docs.rows.length,
    };
  }
}

export const verificationService = new VerificationService();

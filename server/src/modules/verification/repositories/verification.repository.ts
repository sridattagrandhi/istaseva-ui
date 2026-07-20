import { dbQuery } from '../../../common/repositories/database.js';

/**
 * KYC verification is per-user (per Firebase UID), not per-provider.
 * `user_profiles.verification_status` is the source of truth; the
 * `verification_documents` table is the audit trail keyed by `user_id`.
 */
export class VerificationRepository {
  listDocumentsForUser(userId: string) {
    return dbQuery(
      'SELECT * FROM verification_documents WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
  }

  createDocument(payload: {
    user_id: string;
    document_type: string;
    document_number?: string;
    file_url: string;
  }) {
    return dbQuery(
      `INSERT INTO verification_documents
       (user_id, document_type, document_number, file_url, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [payload.user_id, payload.document_type, payload.document_number || null, payload.file_url]
    );
  }

  updateDocumentStatus(documentId: string, status: string, rejectionReason?: string) {
    return dbQuery(
      `UPDATE verification_documents
       SET status = $2,
           rejection_reason = $3,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [documentId, status, rejectionReason || null]
    );
  }

  updateUserVerificationStatus(userId: string, status: string) {
    return dbQuery(
      `UPDATE user_profiles
       SET verification_status = $2,
           verified_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE verified_at END,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, verification_status, verified_at`,
      [userId, status]
    );
  }

  countApprovedDocumentsForUser(userId: string) {
    return dbQuery(
      `SELECT COUNT(*) as count FROM verification_documents
       WHERE user_id = $1 AND status = 'approved'`,
      [userId]
    );
  }

  getDocumentById(documentId: string) {
    return dbQuery(
      'SELECT * FROM verification_documents WHERE id = $1',
      [documentId]
    );
  }

  getVerificationStatusForUser(userId: string) {
    return dbQuery<{ verification_status: string; verified_at: string | null }>(
      'SELECT verification_status, verified_at FROM user_profiles WHERE user_id = $1 LIMIT 1',
      [userId]
    );
  }
}

export const verificationRepository = new VerificationRepository();

// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../../common/errors/app-error.js';

const repo = {
  getByUserId: vi.fn(),
  updateByUserId: vi.fn(),
  insertConsent: vi.fn(),
  getLatestConsents: vi.fn(),
};

vi.mock('../repositories/users.repository.js', () => ({
  usersRepository: repo,
}));

describe('UsersService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getMyProfile returns the row when present', async () => {
    const { usersService } = await import('./users.service.js');
    repo.getByUserId.mockResolvedValue({ rows: [{ id: '1', display_name: 'A' }] });
    const r = await usersService.getMyProfile('u1');
    expect(r.data.display_name).toBe('A');
  });

  it('getMyProfile throws NotFound when row is missing', async () => {
    const { usersService } = await import('./users.service.js');
    repo.getByUserId.mockResolvedValue({ rows: [] });
    await expect(usersService.getMyProfile('u1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updateMyProfile throws NotFound when no row matches the user', async () => {
    const { usersService } = await import('./users.service.js');
    repo.updateByUserId.mockResolvedValue({ rows: [] });
    await expect(usersService.updateMyProfile('u1', { display_name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('setMyConsent appends a versioned consent row (never updates in place)', async () => {
    const { usersService } = await import('./users.service.js');
    repo.insertConsent.mockResolvedValue({ rows: [{ consent_type: 'marketing', version: '1.0.0', granted: true }] });

    const r = await usersService.setMyConsent({
      userId: 'u1',
      consentType: 'marketing',
      granted: true,
      ipAddress: '1.2.3.4',
      userAgent: 'test-agent',
    });

    expect(repo.insertConsent).toHaveBeenCalledWith({
      userId: 'u1',
      consentType: 'marketing',
      version: '1.0.0',
      granted: true,
      ipAddress: '1.2.3.4',
      userAgent: 'test-agent',
    });
    expect(r.data).toMatchObject({ consent_type: 'marketing', granted: true });
  });

  it('setMyConsent stamps the analytics-consent version for the analytics type (LEG-014)', async () => {
    const { usersService } = await import('./users.service.js');
    const { ANALYTICS_CONSENT_VERSION } = await import('../legal-docs-version.js');
    repo.insertConsent.mockResolvedValue({ rows: [{ consent_type: 'analytics', version: ANALYTICS_CONSENT_VERSION, granted: true }] });

    await usersService.setMyConsent({ userId: 'u1', consentType: 'analytics', granted: true });

    expect(repo.insertConsent).toHaveBeenCalledWith(
      expect.objectContaining({ consentType: 'analytics', version: ANALYTICS_CONSENT_VERSION, granted: true }),
    );
  });

  it('setMyConsent stamps the age-confirmation version for the age_confirmation type (LEG-003)', async () => {
    const { usersService } = await import('./users.service.js');
    const { AGE_CONFIRMATION_VERSION } = await import('../legal-docs-version.js');
    repo.insertConsent.mockResolvedValue({ rows: [{ consent_type: 'age_confirmation', version: AGE_CONFIRMATION_VERSION, granted: true }] });

    await usersService.setMyConsent({ userId: 'u1', consentType: 'age_confirmation', granted: true });

    expect(repo.insertConsent).toHaveBeenCalledWith(
      expect.objectContaining({ consentType: 'age_confirmation', version: AGE_CONFIRMATION_VERSION, granted: true }),
    );
  });

  it('hasMarketingConsent reflects the latest marketing row, defaulting to false when absent', async () => {
    const { usersService } = await import('./users.service.js');

    repo.getLatestConsents.mockResolvedValue({ rows: [{ consent_type: 'marketing', granted: true }] });
    await expect(usersService.hasMarketingConsent('u1')).resolves.toBe(true);

    repo.getLatestConsents.mockResolvedValue({ rows: [{ consent_type: 'marketing', granted: false }] });
    await expect(usersService.hasMarketingConsent('u1')).resolves.toBe(false);

    repo.getLatestConsents.mockResolvedValue({ rows: [{ consent_type: 'terms', granted: true }] });
    await expect(usersService.hasMarketingConsent('u1')).resolves.toBe(false);
  });

  it('getMyConsents returns the latest-per-type rows from the trail', async () => {
    const { usersService } = await import('./users.service.js');
    repo.getLatestConsents.mockResolvedValue({
      rows: [{ consent_type: 'marketing', version: '1.0.0', granted: false, created_at: '2026-07-07T00:00:00Z' }],
    });
    const r = await usersService.getMyConsents('u1');
    expect(repo.getLatestConsents).toHaveBeenCalledWith('u1');
    expect(r.data).toHaveLength(1);
    expect(r.data[0].granted).toBe(false);
  });
});

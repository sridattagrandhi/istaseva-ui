// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const verify = vi.fn();

vi.mock('jsonwebtoken', () => ({
  default: {
    verify,
  },
}));

describe('DefaultAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies JWT tokens using the configured secret in local/jwt mode', async () => {
    verify.mockReturnValue({
      sub: 'user-123',
      email: 'jwt@example.com',
      role: 'admin',
    });

    const { defaultAuthProvider } = await import('./default-auth.provider.js');
    const result = await defaultAuthProvider.verifyAccessToken('jwt-token');

    expect(verify).toHaveBeenCalled();
    expect(result).toEqual({
      id: 'user-123',
      email: 'jwt@example.com',
      role: 'admin',
    });
  });
});

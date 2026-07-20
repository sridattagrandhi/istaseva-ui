// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = {
  listForUser: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
};

vi.mock('../repositories/wishlists.repository.js', () => ({
  wishlistsRepository: repo,
}));

describe('WishlistsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('list() proxies to the repository', async () => {
    const { wishlistsService } = await import('./wishlists.service.js');
    repo.listForUser.mockResolvedValue([{ id: 'a' }]);
    const result = await wishlistsService.list('user-1');
    expect(result).toEqual([{ id: 'a' }]);
    expect(repo.listForUser).toHaveBeenCalledWith('user-1');
  });

  it('add() is idempotent and returns success', async () => {
    const { wishlistsService } = await import('./wishlists.service.js');
    repo.add.mockResolvedValue(undefined);
    const r = await wishlistsService.add('user-1', 'list-1', 'stay' as any);
    expect(r).toEqual({ success: true });
    expect(repo.add).toHaveBeenCalledWith('user-1', 'list-1', 'stay');
  });

  it('remove() returns success even if the row was missing', async () => {
    const { wishlistsService } = await import('./wishlists.service.js');
    repo.remove.mockResolvedValue(undefined);
    const r = await wishlistsService.remove('user-1', 'list-1', 'service' as any);
    expect(r).toEqual({ success: true });
  });
});

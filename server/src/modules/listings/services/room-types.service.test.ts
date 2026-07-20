// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListingNotReadyError } from '../../../common/errors/app-error.js';

const listingsGetById = vi.fn();
const roomTypesListForListing = vi.fn();
const roomTypesGetById = vi.fn();
const roomTypesCreate = vi.fn();
const roomTypesUpdate = vi.fn();
const roomTypesDelete = vi.fn();
const providersGetByUserId = vi.fn();
const verificationListDocumentsForUser = vi.fn();
const verificationGetStatusForUser = vi.fn();

vi.mock('../repositories/listings.repository.js', () => ({
  listingsRepository: { getById: listingsGetById },
}));

vi.mock('../repositories/room-types.repository.js', () => ({
  roomTypesRepository: {
    listForListing: roomTypesListForListing,
    getById: roomTypesGetById,
    create: roomTypesCreate,
    update: roomTypesUpdate,
    delete: roomTypesDelete,
  },
}));

vi.mock('../../providers/repositories/providers.repository.js', () => ({
  providersRepository: { getByUserId: providersGetByUserId },
}));

vi.mock('../../verification/repositories/verification.repository.js', () => ({
  verificationRepository: {
    listDocumentsForUser: verificationListDocumentsForUser,
    getVerificationStatusForUser: verificationGetStatusForUser,
  },
}));

function activeHotel() {
  return {
    id: 'hotel-1',
    user_id: 'user-1',
    is_active: true,
    listing_type: 'stay',
    name: 'Sunset Hotel',
    category: 'hotel',
    description: 'Cozy stays',
    location: 'Goa',
    property_type: 'hotel',
    availability: 'Always',
    photos: ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'],
  };
}

const goodRoom = {
  id: 'room-1',
  listing_id: 'hotel-1',
  name: 'Deluxe',
  base_price_paise: 500000,
  max_guests: 2,
  quantity: 5,
  photos: ['r1.jpg'],
};

describe('RoomTypesService active-listing guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providersGetByUserId.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    verificationGetStatusForUser.mockResolvedValue({
      rows: [{ verification_status: 'verified' }],
    });
    verificationListDocumentsForUser.mockResolvedValue({
      rows: [{ document_type: 'aadhaar', status: 'approved' }],
    });
  });

  it('rejects deleting the last room type on an active hotel', async () => {
    listingsGetById.mockResolvedValue({ rows: [activeHotel()] });
    roomTypesGetById.mockResolvedValue({ rows: [goodRoom] });
    roomTypesListForListing.mockResolvedValue({ rows: [goodRoom] });
    const { roomTypesService } = await import('./room-types.service.js');

    await expect(
      roomTypesService.delete('hotel-1', 'room-1', 'user-1'),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    expect(roomTypesDelete).not.toHaveBeenCalled();
  });

  it('rejects updating an active hotel room price to 0', async () => {
    listingsGetById.mockResolvedValue({ rows: [activeHotel()] });
    roomTypesGetById.mockResolvedValue({ rows: [goodRoom] });
    roomTypesListForListing.mockResolvedValue({ rows: [goodRoom] });
    const { roomTypesService } = await import('./room-types.service.js');

    await expect(
      roomTypesService.update('hotel-1', 'room-1', 'user-1', { base_price_paise: 0 }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    expect(roomTypesUpdate).not.toHaveBeenCalled();
  });

  it('rejects removing all photos from an active hotel room', async () => {
    listingsGetById.mockResolvedValue({ rows: [activeHotel()] });
    roomTypesGetById.mockResolvedValue({ rows: [goodRoom] });
    roomTypesListForListing.mockResolvedValue({ rows: [goodRoom] });
    const { roomTypesService } = await import('./room-types.service.js');

    await expect(
      roomTypesService.update('hotel-1', 'room-1', 'user-1', { photos: [] }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    expect(roomTypesUpdate).not.toHaveBeenCalled();
  });

  it('allows benign edits on an already-broken active hotel (leniency rule)', async () => {
    // Hosts of multi-room hotels often arrive with a legacy row set where
    // ONE room is missing a field (no photos, quantity=0, etc.). The
    // guard's leniency comment (room-types.service.ts:38–47) says:
    // don't block edits that DON'T introduce new failures — otherwise
    // the host can't fix room 1 until room 2 is also fully filled.
    //
    // Here: room set is already unready (quantity=0). Edit is benign
    // ({description}). Guard should let it through; the repo update
    // gets called; no ListingNotReadyError fires.
    listingsGetById.mockResolvedValue({ rows: [activeHotel()] });
    roomTypesGetById.mockResolvedValue({ rows: [{ ...goodRoom, quantity: 0 }] });
    roomTypesListForListing.mockResolvedValue({
      rows: [{ ...goodRoom, quantity: 0 }],
    });
    roomTypesUpdate.mockResolvedValue({ rows: [{ ...goodRoom, quantity: 0, description: 'tweak' }] });
    const { roomTypesService } = await import('./room-types.service.js');

    const result = await roomTypesService.update(
      'hotel-1', 'room-1', 'user-1', { description: 'tweak' },
    );
    expect(roomTypesUpdate).toHaveBeenCalled();
    expect(result.data.description).toBe('tweak');
  });

  it('blocks edits that introduce a NEW failure on an active hotel', async () => {
    // The complement of the leniency rule: a previously-valid room set
    // that the edit would break should still be rejected. Start from
    // a healthy room and try to remove its photos (room_type_photos_required
    // is a fresh regression — currentCodes doesn't contain it).
    listingsGetById.mockResolvedValue({ rows: [activeHotel()] });
    roomTypesGetById.mockResolvedValue({ rows: [goodRoom] });
    roomTypesListForListing.mockResolvedValue({ rows: [goodRoom] });
    const { roomTypesService } = await import('./room-types.service.js');

    await expect(
      roomTypesService.update('hotel-1', 'room-1', 'user-1', { photos: [] }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    expect(roomTypesUpdate).not.toHaveBeenCalled();
  });

  it('allows the same edits on an inactive hotel draft', async () => {
    listingsGetById.mockResolvedValue({ rows: [{ ...activeHotel(), is_active: false }] });
    roomTypesGetById.mockResolvedValue({ rows: [goodRoom] });
    roomTypesListForListing.mockResolvedValue({ rows: [goodRoom] });
    roomTypesDelete.mockResolvedValue({ rows: [{ id: 'room-1' }] });
    const { roomTypesService } = await import('./room-types.service.js');

    const result = await roomTypesService.delete('hotel-1', 'room-1', 'user-1');
    expect(result.success).toBe(true);
    expect(roomTypesDelete).toHaveBeenCalled();
  });

  it('allows valid updates on an active hotel room', async () => {
    listingsGetById.mockResolvedValue({ rows: [activeHotel()] });
    roomTypesGetById.mockResolvedValue({ rows: [goodRoom] });
    roomTypesListForListing.mockResolvedValue({ rows: [goodRoom] });
    roomTypesUpdate.mockResolvedValue({ rows: [{ ...goodRoom, name: 'Premium' }] });
    const { roomTypesService } = await import('./room-types.service.js');

    const result = await roomTypesService.update('hotel-1', 'room-1', 'user-1', { name: 'Premium' });
    expect(result.data.name).toBe('Premium');
  });
});

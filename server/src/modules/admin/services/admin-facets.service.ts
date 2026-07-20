import { adminFacetsRepository } from '../repositories/admin-facets.repository.js';

export const adminFacetsService = {
  async listingFacets() {
    return adminFacetsRepository.listingFacets();
  },
};

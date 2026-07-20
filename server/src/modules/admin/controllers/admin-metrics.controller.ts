import { Request, Response, NextFunction } from 'express';
import { adminMetricsService, type WindowOpts } from '../services/admin-metrics.service.js';
import { strList } from './admin-bookings.controller.js';
import type { MetricListingFilter } from '../repositories/admin-metric-filters.js';

// Range selectors: either an explicit `?from=YYYY-MM-DD&to=YYYY-MM-DD` calendar
// window (month / year / financial-year pickers) or `?days=N` (1..400 trailing;
// the service clamps). from/to win when both are valid.
function parseWindow(req: Request): WindowOpts {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const rawDays = Number(req.query.days);
  return { from, to, days: Number.isFinite(rawDays) ? rawDays : 30 };
}

// Listing-scoped filter for the analytics tabs' filterable tiles. Same
// comma-separated multi-select format the ops screens use, plus an exact
// `listingId` from the "query by specific listing" search picker.
function parseFilter(req: Request): MetricListingFilter {
  const listingId =
    typeof req.query.listingId === 'string' && req.query.listingId.trim()
      ? req.query.listingId.trim().slice(0, 100)
      : null;
  return {
    types: strList(req.query.types) ?? [],
    categories: strList(req.query.categories) ?? [],
    states: strList(req.query.states) ?? [],
    cities: strList(req.query.cities) ?? [],
    listingId,
  };
}

export class AdminMetricsController {
  async overview(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getOverview(parseWindow(req)));
    } catch (err) { next(err); }
  }

  async funnel(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getFunnel(parseWindow(req)));
    } catch (err) { next(err); }
  }

  async searchTerms(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      res.json(await adminMetricsService.getSearchTerms(parseWindow(req), Number.isFinite(limit) ? limit : 20));
    } catch (err) { next(err); }
  }

  async engagement(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getEngagement(parseWindow(req)));
    } catch (err) { next(err); }
  }

  async geo(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      res.json(await adminMetricsService.getGeo(parseWindow(req), Number.isFinite(limit) ? limit : 15, parseFilter(req)));
    } catch (err) { next(err); }
  }

  // Filtered Bookings tile + chart (Overview) — live source, only hit when the
  // analytics filter bar is active.
  async filteredBookings(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getFilteredBookings(parseWindow(req), parseFilter(req)));
    } catch (err) { next(err); }
  }

  // Filtered Providers tiles + new-listings chart — live source.
  async filteredProviders(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getFilteredProviders(parseWindow(req), parseFilter(req)));
    } catch (err) { next(err); }
  }

  async acquisition(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      res.json(await adminMetricsService.getAcquisition(parseWindow(req), Number.isFinite(limit) ? limit : 12));
    } catch (err) { next(err); }
  }

  async customers(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      res.json(await adminMetricsService.getCustomers(parseWindow(req), Number.isFinite(limit) ? limit : 10, parseFilter(req)));
    } catch (err) { next(err); }
  }

  async languages(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getLanguages(parseWindow(req)));
    } catch (err) { next(err); }
  }

  async origins(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      res.json(await adminMetricsService.getOrigins(parseWindow(req), Number.isFinite(limit) ? limit : 15));
    } catch (err) { next(err); }
  }

  async originDest(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      res.json(await adminMetricsService.getOriginDest(parseWindow(req), Number.isFinite(limit) ? limit : 15));
    } catch (err) { next(err); }
  }

  async paymentFailures(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getPaymentFailures(parseWindow(req)));
    } catch (err) { next(err); }
  }

  async cancelReasons(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getCancelReasons(parseWindow(req)));
    } catch (err) { next(err); }
  }

  async freshness(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getFreshness());
    } catch (err) { next(err); }
  }

  async revenueSummary(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await adminMetricsService.getRevenueSummary(parseWindow(req), parseFilter(req)));
    } catch (err) { next(err); }
  }

  async revenueBreakdown(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      const dim = typeof req.query.dim === 'string' ? req.query.dim : undefined;
      res.json(await adminMetricsService.getRevenueBreakdown(parseWindow(req), dim, Number.isFinite(limit) ? limit : 12));
    } catch (err) { next(err); }
  }

  async revenueSeries(req: Request, res: Response, next: NextFunction) {
    try {
      const dim = typeof req.query.dim === 'string' ? req.query.dim : undefined;
      const key = typeof req.query.key === 'string' ? req.query.key : undefined;
      res.json(await adminMetricsService.getRevenueSeries(parseWindow(req), dim, key));
    } catch (err) { next(err); }
  }

  async revenueListings(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      const dim = typeof req.query.dim === 'string' ? req.query.dim : undefined;
      const key = typeof req.query.key === 'string' ? req.query.key : undefined;
      res.json(await adminMetricsService.getRevenueListings(parseWindow(req), dim, key, Number.isFinite(limit) ? limit : 10));
    } catch (err) { next(err); }
  }
}

export const adminMetricsController = new AdminMetricsController();

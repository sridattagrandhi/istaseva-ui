import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { adminFeesService } from '../services/admin-fees.service.js';

const createFeeRuleSchema = z.object({
  // 'customer' rules price bookings (resolved in createHold). 'business'
  // rules are the partner-payout commission: stored, audited, and
  // simulatable now — payout deduction wiring lands with the payouts work,
  // so nothing charges off them yet.
  audience: z.enum(['customer', 'business']),
  category: z.enum(['stays', 'services', 'transport']).nullish(),
  // Specific service type within the vertical (listing-category value space,
  // e.g. 'salon' / 'hotel' / 'driver-cab'). The service validates it belongs
  // to the declared category.
  subcategory: z.string().max(80).nullish(),
  scopeType: z.enum(['global', 'state', 'city_tier', 'city', 'listing']),
  scopeState: z.string().max(80).nullish(),
  scopeCity: z.string().max(120).nullish(),
  scopeTier: z.enum(['tier1', 'tier2', 'tier3']).nullish(),
  scopeListingId: z.string().uuid().nullish(),
  percentBps: z.number().int().min(0).max(10000),
  fixedPaise: z.number().int().min(0).max(10_000_000),
  minFeePaise: z.number().int().min(0).max(10_000_000).nullish(),
  maxFeePaise: z.number().int().min(0).max(10_000_000).nullish(),
  effectiveFrom: z.string().datetime({ offset: true }).nullish(),
  effectiveTo: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().max(500).nullish(),
});

const upsertTierSchema = z.object({
  city: z.string().min(1).max(120),
  state: z.string().min(1).max(80),
  tier: z.enum(['tier1', 'tier2', 'tier3']),
});

const simulateSchema = z.object({
  audience: z.enum(['customer', 'business']).optional(),
  listingId: z.string().uuid().nullish(),
  category: z.string().max(60).nullish(),
  city: z.string().max(120).nullish(),
  state: z.string().max(80).nullish(),
  subtotalPaise: z.number().int().min(0).max(1_000_000_000),
  includeInsurance: z.boolean().optional(),
});

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AdminFeesController {
  async listRules(req: Request, res: Response, next: NextFunction) {
    try {
      const rules = await adminFeesService.listRules({
        audience: str(req.query.audience),
        category: str(req.query.category),
        subcategory: str(req.query.subcategory),
        scopeType: str(req.query.scopeType),
        includeInactive: str(req.query.includeInactive) === 'true',
      });
      res.json({ rules });
    } catch (err) { next(err); }
  }

  async createRule(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createFeeRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }
      const rule = await adminFeesService.createRule(req.user!.id, {
        ...parsed.data,
        category: parsed.data.category ?? null,
      });
      res.status(201).json({ rule });
    } catch (err) { next(err); }
  }

  /** Edit-as-replace: same body as create; retires :id and creates the
   *  edited version atomically. */
  async replaceRule(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createFeeRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }
      const rule = await adminFeesService.replaceRule(req.user!.id, String(req.params.id), {
        ...parsed.data,
        category: parsed.data.category ?? null,
      });
      res.status(201).json({ rule });
    } catch (err) { next(err); }
  }

  async deactivateRule(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      const rule = await adminFeesService.deactivateRule(req.user!.id, String(req.params.id), reason);
      res.json({ rule });
    } catch (err) { next(err); }
  }

  async listTiers(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ tiers: await adminFeesService.listTiers() });
    } catch (err) { next(err); }
  }

  async upsertTier(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = upsertTierSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
      }
      res.status(201).json({ tier: await adminFeesService.upsertTier(req.user!.id, parsed.data) });
    } catch (err) { next(err); }
  }

  async deleteTier(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ tier: await adminFeesService.deleteTier(req.user!.id, String(req.params.id)) });
    } catch (err) { next(err); }
  }

  async simulate(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = simulateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }
      res.json(await adminFeesService.simulate(parsed.data));
    } catch (err) { next(err); }
  }
}

export const adminFeesController = new AdminFeesController();

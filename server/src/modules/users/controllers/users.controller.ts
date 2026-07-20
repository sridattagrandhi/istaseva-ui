import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/app-error.js';
import { usersService } from '../services/users.service.js';
import { accountLifecycleService } from '../services/account-lifecycle.service.js';
import { updateUserProfileSchema } from '../schemas/user-profile.schema.js';

// 'marketing' is the opt-in toggle; 'terms' records the signup-time
// acceptance of the Terms + Privacy Policy; 'analytics' records the
// cookie/device-analytics choice (LEG-014) so the banner/panel decision lands
// in the auditable trail, not just device localStorage; 'age_confirmation'
// records the 18+ attestation (LEG-003) as its own row, distinct from the
// terms acceptance. All are versioned in the consent trail (see
// users.service.setMyConsent).
const consentTypeSchema = z.enum(['marketing', 'terms', 'analytics', 'age_confirmation']);
const setConsentSchema = z.object({ granted: z.boolean() });

export class UsersController {
  async getMyProfile(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await usersService.getMyProfile(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async updateMyProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = updateUserProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid profile update payload');
      }

      res.json(await usersService.updateMyProfile(req.user!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  }

  async getMyConsents(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await usersService.getMyConsents(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async putMyConsent(req: Request, res: Response, next: NextFunction) {
    try {
      const type = consentTypeSchema.safeParse(req.params.type);
      if (!type.success) throw new ValidationError('Unknown consent type');
      const body = setConsentSchema.safeParse(req.body);
      if (!body.success) throw new ValidationError('granted must be a boolean');

      res.json(await usersService.setMyConsent({
        userId: req.user!.id,
        consentType: type.data,
        granted: body.data.granted,
        ipAddress: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null,
      }));
    } catch (err) {
      next(err);
    }
  }

  // ---- Account lifecycle (PRIV-002): DSAR export + account deletion ----

  async requestMyExport(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(202).json(await accountLifecycleService.requestExport(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async getMyExport(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await accountLifecycleService.getExportStatus(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async requestMyDeletion(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(202).json(await accountLifecycleService.requestDeletion(req.user!.id, req.user!.authTimeMs));
    } catch (err) {
      next(err);
    }
  }

  async getMyDeletion(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await accountLifecycleService.getDeletionStatus(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async cancelMyDeletion(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await accountLifecycleService.cancelDeletion(req.user!.id));
    } catch (err) {
      next(err);
    }
  }
}

export const usersController = new UsersController();

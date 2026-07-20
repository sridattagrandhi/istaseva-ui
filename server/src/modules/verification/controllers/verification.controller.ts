import { Request, Response, NextFunction } from 'express';
import { verificationService } from '../services/verification.service.js';

export class VerificationController {
  async listDocuments(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await verificationService.listDocuments(req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async createDocument(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(201).json(await verificationService.createDocument(req.user!.id, req.body));
    } catch (err) {
      next(err);
    }
  }

  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await verificationService.getUserVerificationStatus(req.user!.id);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const verificationController = new VerificationController();

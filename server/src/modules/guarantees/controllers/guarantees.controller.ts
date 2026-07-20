import { Request, Response, NextFunction } from 'express';
import { guaranteesService } from '../services/guarantees.service.js';

export class GuaranteesController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(201).json(await guaranteesService.create(req.user!.id, req.body));
    } catch (err) {
      next(err);
    }
  }

  async getByBookingId(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await guaranteesService.getByBookingId(String(req.params.bookingId), req.user!.id));
    } catch (err) {
      next(err);
    }
  }

  async fileClaim(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await guaranteesService.fileClaim(String(req.params.id), req.user!.id, String(req.body.description || '')));
    } catch (err) {
      next(err);
    }
  }
}

export const guaranteesController = new GuaranteesController();

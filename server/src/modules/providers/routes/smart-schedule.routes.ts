import { Router } from 'express';
import { smartScheduleController } from '../controllers/smart-schedule.controller.js';

const router = Router();

router.post('/', smartScheduleController.findSlots.bind(smartScheduleController));

export default router;

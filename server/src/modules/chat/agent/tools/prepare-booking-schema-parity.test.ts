// @vitest-environment node
//
// Guards the two parallel input contracts for assistant bookings:
//   • prepare_booking TOOL's ArgsSchema (what the model can pass)
//   • POST /api/assistant/prepare-booking controller schema (the retry path,
//     which echoes the tool's bookingArgs — e.g. the add-on offer retry)
//
// These are maintained by hand. If a field is added to the tool but not the
// controller, the retry SILENTLY DROPS it (Zod strips unknown keys) — exactly
// the bug where a multi-room booking collapsed to 1 room ("Single sleeps up
// to 1") on confirm. This test fails the moment they drift, so the next field
// can't regress unnoticed.
import { describe, it, expect } from 'vitest';
import { prepareBookingTool } from './prepare-booking.tool.js';
import { prepareBookingSchema } from '../../controllers/user-assistant.controller.js';

// Unwrap ZodEffects (.refine/.transform wrappers) to reach the underlying
// ZodObject — the tool's ArgsSchema has a .refine, so its `.shape` lives one
// level in. The controller schema is a plain object (.shape directly).
const keysOf = (schema: unknown): string[] => {
  let s = schema as any;
  while (s && !s.shape && s._def?.schema) s = s._def.schema;
  return Object.keys(s.shape).sort();
};

// The controller MAY carry user-action-only fields the tool omits. None today
// (the caste affirmation was removed) — kept as the extension point.
const CONTROLLER_ONLY = new Set<string>([]);

describe('prepare_booking tool ↔ retry-endpoint schema parity', () => {
  const toolKeys = keysOf(prepareBookingTool.argsSchema);
  const ctrlKeys = new Set(keysOf(prepareBookingSchema));

  it('every tool arg is accepted by the retry endpoint (no silent drops)', () => {
    const missing = toolKeys.filter((k) => !ctrlKeys.has(k));
    expect(missing, `retry endpoint is missing tool fields: ${missing.join(', ')}`).toEqual([]);
  });

  it('the retry endpoint adds only the known user-action-only fields', () => {
    const toolSet = new Set(toolKeys);
    const extra = [...ctrlKeys].filter((k) => !toolSet.has(k) && !CONTROLLER_ONLY.has(k));
    expect(extra, `retry endpoint has unexpected extra fields: ${extra.join(', ')}`).toEqual([]);
  });

  it('numberOfRooms is in both (the field whose absence caused the bug)', () => {
    expect(toolKeys).toContain('numberOfRooms');
    expect(ctrlKeys.has('numberOfRooms')).toBe(true);
  });
});

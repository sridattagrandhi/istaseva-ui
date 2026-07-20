import { z } from 'zod';
import type { ToolDefinition } from '../../types.js';
import type { OnboardingAgentContext, OnboardingPickerAction } from '../types.js';

/**
 * Tells the UI what picker overlay to surface this turn — category grid,
 * GPS location picker, photo uploader, etc. The legacy onboarding chat
 * had this as an `action` field on the JSON reply; making it a tool lets
 * the agent reason ("did I already ask for category? then call
 * set_picker_action(none) so the overlay closes").
 *
 * Only the most recent set_picker_action call this turn wins — the loop
 * stamps `ctx.pickerAction` and the final reply ships it.
 */
const ArgsSchema = z.object({
  action: z.enum([
    'category_select',
    'location_picker',
    'photo_upload',
    'price_input',
    'availability_select',
    'none',
  ]),
});
type Args = z.infer<typeof ArgsSchema>;

export const setPickerActionTool: ToolDefinition<Args, { action: OnboardingPickerAction }> = {
  name: 'set_picker_action',
  description:
    'Tell the UI which picker overlay to show. Use category_select for the category grid, location_picker for the GPS picker, photo_upload for the uploader, availability_select for the schedule chooser, or "none" to leave plain chat. Default to "none" — only request a picker when it actually helps.',
  sideEffect: 'write',
  argsSchema: ArgsSchema,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['category_select', 'location_picker', 'photo_upload', 'price_input', 'availability_select', 'none'],
      },
    },
    required: ['action'],
  },

  async execute(args, ctx) {
    const onboardingCtx = ctx as OnboardingAgentContext;
    onboardingCtx.pickerAction = args.action;
    return { action: args.action };
  },

  summarize(args, _result) {
    return args.action === 'none' ? 'Closed picker' : `Asked UI for ${args.action}`;
  },
};

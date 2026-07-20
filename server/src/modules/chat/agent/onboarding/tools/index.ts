/**
 * Onboarding agent tool registry. Kept separate from the main assistant
 * registry so the two agents can't cross-call each other's tools.
 */
import type { ToolDefinition } from '../../types.js';
import { extractFieldsTool } from './extract-fields.tool.js';
import { setPickerActionTool } from './set-picker-action.tool.js';
import { submitListingTool } from './submit-listing.tool.js';
import { lookupContextTool } from './lookup-context.tool.js';

export const ONBOARDING_TOOLS: ToolDefinition[] = [
  extractFieldsTool as ToolDefinition,
  setPickerActionTool as ToolDefinition,
  submitListingTool as ToolDefinition,
  lookupContextTool as ToolDefinition,
];

export const ONBOARDING_TOOLS_BY_NAME: Record<string, ToolDefinition> = Object.fromEntries(
  ONBOARDING_TOOLS.map((t) => [t.name, t]),
);

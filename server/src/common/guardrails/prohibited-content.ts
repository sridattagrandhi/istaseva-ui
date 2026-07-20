/**
 * Deterministic "legal / safe" guardrail for onboarding/listing values.
 *
 * Lives in `common/guardrails` (not inside a module) because BOTH the
 * onboarding chat agent (extract_fields) and the listings create gate
 * import it — it must not pull either module into the other.
 *
 * This is the CHEAP front line — a tight, conservative blocklist that
 * catches obviously prohibited content (weapons, hard drugs, sexual
 * services, etc.) on any free-text field without an LLM call. The nuanced
 * "is this VIABLE / coherent" judgment (e.g. "Toyota Spaceship 9000" as a
 * vehicle model, which carries no banned keyword) is the job of the
 * semantic tier — this layer only refuses the clear-cut cases.
 *
 * Kept deliberately narrow to avoid false positives that would block a
 * legitimate host mid-onboarding. Word boundaries everywhere so "bomb"
 * never matches "Bombay", "arms" never matches "Armstrong", etc.
 */

/**
 * A rejected value. Structurally identical to the onboarding registry's
 * `ValidationIssue` so the two interoperate without a cross-module import.
 */
export interface GuardrailIssue {
  /** Field name the issue is about. */
  field: string;
  /** Stable machine code ('prohibited_weapons', 'location_not_in_india', …). */
  code: string;
  /** Human-readable reason the agent re-asks with / the form surfaces. */
  message: string;
  /**
   * Absent (default) = blocking: create/update rejects the payload.
   * 'warn' = advisory: the listing saves and the message is returned to the
   * host (e.g. address_in_prose — "move your street address to the location
   * field"). Callers that throw on issues MUST filter warnings out first.
   */
  severity?: 'warn';
}

interface ProhibitedRule {
  code: string;
  label: string;
  pattern: RegExp;
}

// Each pattern is case-insensitive and word-bounded. Presence is what
// matters; the first match only decides the message wording.
const PROHIBITED_RULES: ProhibitedRule[] = [
  {
    code: 'weapons',
    label: 'weapons, firearms or ammunition',
    pattern: /\b(guns?|firearms?|pistols?|revolvers?|rifles?|shotguns?|ammo|ammunition|grenades?|explosives?|ied|ieds)\b/i,
  },
  {
    code: 'drugs',
    label: 'illegal drugs',
    pattern: /\b(cocaine|heroin|meth|methamphetamine|mdma|ecstasy|lsd|narcotics?|opium)\b/i,
  },
  {
    code: 'sexual_services',
    label: 'sexual or adult services',
    pattern: /\b(escorts?|prostitut\w+|brothels?)\b/i,
  },
  {
    code: 'human_trafficking',
    label: 'trafficking or exploitation',
    pattern: /\b(human\s+trafficking|sex\s+trafficking|bonded\s+labou?r)\b/i,
  },
  {
    code: 'violence',
    label: 'violence or threats',
    pattern: /\b(contract\s+killing|hitman|assassinat\w+)\b/i,
  },
];

/** Pull every plain string out of a value (string, or array of strings). */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Scan a field's value for clearly-prohibited content. Returns one issue
 * (the first rule that matched) or `[]`. Non-string values yield `[]` —
 * numbers/booleans/structured rows can't carry this kind of text, and the
 * structured fields validate their own shape via zod + customGate.
 */
export function scanProhibitedContent(field: string, value: unknown): GuardrailIssue[] {
  const texts = stringsIn(value);
  if (texts.length === 0) return [];
  for (const text of texts) {
    for (const rule of PROHIBITED_RULES) {
      if (rule.pattern.test(text)) {
        return [{
          field,
          code: `prohibited_${rule.code}`,
          message: `That mentions ${rule.label}, which isn't allowed on the platform. Please give a legitimate answer for "${field}".`,
        }];
      }
    }
  }
  return [];
}

export { PROHIBITED_RULES };

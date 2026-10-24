/**
 * The curated prompt library (content/prompts.json, DESIGN §9): player prompts that worked well,
 * shown as inspiration on the start screen and used to seed "surprise me". Entries with a
 * `worldId` have a recorded world in content/worlds/<worldId>.json that plays in demo mode.
 */
import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase ASCII id').max(64);

export const PromptEntry = z.object({
  id: Id,
  /** the player prompt, verbatim (what the world request sends) */
  prompt: z.string().min(20).max(500),
  /** BCP-47 language of the prompt (and of its world) */
  language: z.string().min(2).max(12),
  genre: z.string().min(2).max(40),
  /** tone and theme tags */
  tags: z.array(z.string().min(1).max(24)).min(1).max(8),
  /** one line for the inspiration card */
  teaser: z.string().min(5).max(120),
  /** conflict is mostly social / investigative */
  nonViolent: z.boolean(),
  /** id of the recorded world (content/worlds/<worldId>.json), when there is one */
  worldId: Id.optional(),
});
export type PromptEntry = z.infer<typeof PromptEntry>;

export const PromptLibrary = z
  .object({
    version: z.literal(1),
    prompts: z.array(PromptEntry).min(1),
  })
  .superRefine((lib, ctx) => {
    const seen = new Set<string>();
    lib.prompts.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: 'custom', path: ['prompts', i, 'id'], message: `duplicate id "${p.id}"` });
      seen.add(p.id);
    });
  });
export type PromptLibrary = z.infer<typeof PromptLibrary>;

/** parses the library; invalid entries are dropped (each reported in `errors`) so one bad line never hides the rest */
export function parsePromptLibrary(raw: unknown): { prompts: PromptEntry[]; errors: string[] } {
  const whole = PromptLibrary.safeParse(raw);
  if (whole.success) return { prompts: whole.data.prompts, errors: [] };
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { prompts?: unknown }).prompts) ? ((raw as { prompts: unknown[] }).prompts) : [];
  const prompts: PromptEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((p, i) => {
    const r = PromptEntry.safeParse(p);
    if (!r.success) errors.push(`prompts[${i}]: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
    else if (seen.has(r.data.id)) errors.push(`prompts[${i}]: duplicate id "${r.data.id}"`);
    else {
      seen.add(r.data.id);
      prompts.push(r.data);
    }
  });
  if (!list.length) errors.push('not a prompt library ({version: 1, prompts: [...]})');
  return { prompts, errors };
}

/** the language part of a tag ("nb-NO" → "nb") */
export function baseLanguage(tag: string | undefined): string {
  return (tag ?? 'en').split('-')[0]!.toLowerCase() || 'en';
}

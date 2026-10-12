import { z } from 'zod';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { type FieldContext, type FieldListItem, type Role, buildContext, listFields, staticHelp } from './context.js';
import type { AssistantLimiter } from './limits.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { AssistantUnavailableError, type AssistantProvider, type UnavailableReason } from './provider.js';

export const QUESTION_MAX = 1000;
/** A bounded answer: the instruction asks for about 120 words; this is the hard stop. */
const ANSWER_MAX_CHARS = 1200;

/** The browser sends only which screen and field the question is about, and the question itself. */
export const askSchema = z
  .object({
    resourceId: z.string().min(1).max(64),
    fieldId: z.string().min(1).max(64),
    question: z.string().trim().min(1).max(QUESTION_MAX),
  })
  .strict();

export interface Asker {
  userId: string;
  role: Role;
}

export type StaticHelp = ReturnType<typeof staticHelp>;

export type AskResult =
  | { kind: 'answer'; answer: string; help: StaticHelp }
  /** No AI answer; `help` is what the catalog says about the field, and the rest of the application is unaffected. */
  | { kind: 'unavailable'; reason: UnavailableReason | 'budget'; message: string; help: StaticHelp }
  | { kind: 'rate_limited'; retryAfterSeconds: number; message: string; help: StaticHelp };

export class AssistantService {
  constructor(
    private readonly provider: AssistantProvider,
    private readonly limiter: AssistantLimiter,
  ) {}

  /** The fields of a screen the person may ask about; 404 for an unknown screen or one their role cannot open. */
  fields(asker: Asker, resourceId: string): FieldListItem[] {
    const fields = listFields(asker.role, resourceId);
    if (!fields) throw new NotFoundError('help for this screen');
    return fields;
  }

  async ask(asker: Asker, input: unknown): Promise<AskResult> {
    const parsed = askSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('invalid_request', `Send resourceId, fieldId and a question of 1 to ${QUESTION_MAX} characters.`);
    }
    const { resourceId, fieldId, question } = parsed.data;
    // Access is decided here, from the user's role and the catalog: what the browser claims about the form is not trusted.
    const ctx: FieldContext | null = buildContext(asker.role, resourceId, fieldId);
    if (!ctx) throw new NotFoundError('help for this field');
    const help = staticHelp(ctx);

    const decision = this.limiter.take(asker.userId);
    if (!decision.ok) {
      if (decision.reason === 'rate') {
        return { kind: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds, message: 'Too many questions in a minute. Try again shortly.', help };
      }
      return { kind: 'unavailable', reason: 'budget', message: 'The AI help has reached its limit for today. Here is what the field catalog says.', help };
    }

    try {
      const text = await this.provider.ask(SYSTEM_PROMPT, buildUserMessage(ctx, question));
      return { kind: 'answer', answer: text.length > ANSWER_MAX_CHARS ? `${text.slice(0, ANSWER_MAX_CHARS).trimEnd()}…` : text, help };
    } catch (err) {
      const reason = err instanceof AssistantUnavailableError ? err.reason : 'server';
      return { kind: 'unavailable', reason, message: 'The AI help is not available right now. Here is what the field catalog says.', help };
    }
  }
}

import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { OUTCOME_MAX, REASON_MAX, RESOLUTION_MIN, STATUS_CODES } from './workflow.js';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Longest ticket description (requirements section 5.1). */
export const DESCRIPTION_MAX = 1000;

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const uuid = z.uuid();

// Strict objects: unknown or forbidden fields are rejected, never silently passed through.
export const createTicketSchema = z
  .object({
    subject: trimmed(5, 200),
    description: trimmed(1, DESCRIPTION_MAX),
    customerId: uuid,
    groupId: uuid,
    priority: z.enum(PRIORITIES).default('NORMAL'),
    assignedAgentId: uuid.nullish(),
  })
  .strict();

export const updateTicketSchema = z
  .object({
    subject: trimmed(5, 200).optional(),
    description: trimmed(1, DESCRIPTION_MAX).optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export const assignTicketSchema = z
  .object({
    groupId: uuid.optional(),
    assignedAgentId: uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => v.groupId !== undefined || v.assignedAgentId !== undefined, { message: 'nothing to assign' });

export const changeStatusSchema = z
  .object({
    targetStatus: z.enum(STATUS_CODES),
    reason: trimmed(1, REASON_MAX).optional(),
    resolution: trimmed(RESOLUTION_MIN, OUTCOME_MAX).optional(),
    unresolvedReason: trimmed(RESOLUTION_MIN, OUTCOME_MAX).optional(),
    // Reassignment applied atomically with the transition (needed to reopen with a valid assignee).
    groupId: uuid.optional(),
    assignedAgentId: uuid.optional(),
  })
  .strict();

/** Largest batch the bulk status change accepts; bigger selections are split by the operator. */
export const BULK_MAX_TICKETS = 100;

/** The distinct tickets of a batch must fit the limit; raised before the database is touched. */
export function assertBatchSize(distinctTickets: number): void {
  if (distinctTickets > BULK_MAX_TICKETS) {
    throw new ValidationError('batch_too_large', `Select at most ${BULK_MAX_TICKETS} tickets at a time`, { items: `at most ${BULK_MAX_TICKETS} tickets` });
  }
}

export const bulkChangeStatusSchema = z
  .object({
    // id/version pairs as the operator saw them, so every ticket is checked for concurrent edits.
    items: z.array(z.object({ id: uuid, version: z.number().int().positive() }).strict()).min(1),
    targetStatus: z.enum(STATUS_CODES),
    reason: trimmed(1, REASON_MAX).optional(),
    resolution: trimmed(RESOLUTION_MIN, OUTCOME_MAX).optional(),
    unresolvedReason: trimmed(RESOLUTION_MIN, OUTCOME_MAX).optional(),
    // UNRESOLVED applies one shared reason to every ticket; the operator has to say that is appropriate.
    confirmSharedReason: z.boolean().optional(),
  })
  .strict();

export const versionSchema = z.number().int().positive();

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type AssignTicketInput = z.infer<typeof assignTicketSchema>;
export type BulkChangeStatusInput = z.infer<typeof bulkChangeStatusSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: Record<string, string> = {};
  for (const issue of result.error.issues) details[issue.path.join('.') || '(input)'] = issue.message;
  throw new ValidationError('validation', 'Invalid input', details);
}

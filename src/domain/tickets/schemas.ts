import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { OUTCOME_MAX, REASON_MAX, RESOLUTION_MIN, STATUS_CODES } from './workflow.js';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const uuid = z.uuid();

// Strict objects: unknown or forbidden fields are rejected, never silently passed through.
export const createTicketSchema = z
  .object({
    subject: trimmed(5, 200),
    description: trimmed(1, 10000),
    customerId: uuid,
    groupId: uuid,
    priority: z.enum(PRIORITIES).default('NORMAL'),
    assignedAgentId: uuid.nullish(),
  })
  .strict();

export const updateTicketSchema = z
  .object({
    subject: trimmed(5, 200).optional(),
    description: trimmed(1, 10000).optional(),
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

export const versionSchema = z.number().int().positive();

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type AssignTicketInput = z.infer<typeof assignTicketSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: Record<string, string> = {};
  for (const issue of result.error.issues) details[issue.path.join('.') || '(input)'] = issue.message;
  throw new ValidationError('validation', 'Invalid input', details);
}

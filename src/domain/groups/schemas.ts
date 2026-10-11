import { z } from 'zod';

/** Immutable once created; used in integrations and seed data. */
export const groupCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'use 2-40 characters: capital letters, digits and underscore, starting with a letter');
const name = z.string().trim().min(1).max(200);
const description = z
  .string()
  .trim()
  .max(1000)
  .transform((v) => (v === '' ? null : v))
  .nullish();

export const createGroupSchema = z.object({ code: groupCode, name, description }).strict();
export const updateGroupSchema = z
  .object({ name: name.optional(), description, isActive: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
export const membershipSchema = z.object({ agentId: z.uuid(), groupId: z.uuid() }).strict();

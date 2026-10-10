import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../auth/password.js';
import { normalizeEmail } from './email.js';

export const MIN_PASSWORD_LENGTH = 12;

export const emailField = z.string().max(254).transform(normalizeEmail).pipe(z.email());
export const displayNameField = z.string().trim().min(1).max(200);
/** Length only (NIST SP 800-63B): no composition rules, but long enough to resist guessing. */
export const passwordField = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);
export const roleField = z.enum(['ADMIN', 'AGENT']);

export const createUserSchema = z
  .object({ email: emailField, displayName: displayNameField, role: roleField, password: passwordField })
  .strict();

// Role and password are deliberately absent: they change only through their own operations.
export const updateUserSchema = z
  .object({ email: emailField.optional(), displayName: displayNameField.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export const createAgentProfileSchema = z.object({ userId: z.uuid(), displayName: displayNameField.optional() }).strict();
export const updateAgentSchema = z
  .object({ displayName: displayNameField.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

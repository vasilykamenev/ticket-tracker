import type { Customer, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { normalizeEmail } from '../users/email.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { parseInput } from '../tickets/schemas.js';

/** Empty strings from forms become null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();

const fields = {
  name: z.string().trim().min(1).max(200),
  email: z
    .string()
    .max(254)
    .transform(normalizeEmail)
    .pipe(z.email()),
  company: optionalText(200),
  phone: optionalText(50),
  isActive: z.boolean(),
};

export const createCustomerSchema = z
  .object({ name: fields.name, email: fields.email, company: fields.company, phone: fields.phone, isActive: fields.isActive.default(true) })
  .strict();

export const updateCustomerSchema = z
  .object({ name: fields.name.optional(), email: fields.email.optional(), company: fields.company, phone: fields.phone, isActive: fields.isActive.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

const DUPLICATE = new ValidationError('validation', 'Invalid input', { email: 'a customer with this email already exists' });

/**
 * Customers are a shared staff directory: any signed-in staff member may create one, only ADMIN may
 * edit or deactivate. Customers are never deleted, only deactivated.
 */
export class CustomerService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(_actor: Actor, input: unknown): Promise<Customer> {
    const data = parseInput(createCustomerSchema, input);
    try {
      return await this.prisma.customer.create({
        data: { name: data.name, emailNormalized: data.email, company: data.company ?? null, phone: data.phone ?? null, isActive: data.isActive },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw DUPLICATE;
      throw err;
    }
  }

  async update(actor: Actor, customerId: string, input: unknown): Promise<Customer> {
    if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may edit customers');
    const data = parseInput(updateCustomerSchema, input);
    if (!z.uuid().safeParse(customerId).success) throw new NotFoundError('customer');
    try {
      return await this.prisma.customer.update({
        where: { id: customerId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.email !== undefined && { emailNormalized: data.email }),
          ...(data.company !== undefined && { company: data.company }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw DUPLICATE;
      if ((err as { code?: string } | null)?.code === 'P2025') throw new NotFoundError('customer');
      throw err;
    }
  }
}

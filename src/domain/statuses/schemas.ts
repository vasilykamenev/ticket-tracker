import { z } from 'zod';

// Only presentation can change. The code is fixed by the workflow in src/domain/tickets/workflow.ts.
export const updateStatusSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use a color like #3b82f6').optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

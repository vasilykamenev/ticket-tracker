import type { ResourceWithOptions } from 'adminjs';
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import type { CustomerService } from '../../domain/customers/customer-service.js';
import { GuardedResource } from '../guarded-resource.js';
import { NO_DELETE, adminOnly, onlyIn } from './helpers.js';

const fromForm = (p: Record<string, unknown>) => ({
  name: p.name,
  email: p.emailNormalized,
  company: p.company,
  phone: p.phone,
  isActive: p.isActive,
});

/** Customers are a shared directory: everyone reads and creates, only ADMIN edits or deactivates. */
export function customerResource(prisma: PrismaClient, customers: CustomerService): ResourceWithOptions {
  const resource = new GuardedResource(
    { model: getModelByName('Customer'), client: prisma },
    {
      errorFields: { email: 'emailNormalized' },
      fallbackErrorField: 'name',
      create: (actor, p) => customers.create(actor, { ...fromForm(p), isActive: p.isActive ?? true }),
      update: (actor, id, p) =>
        customers.update(
          actor,
          id,
          Object.fromEntries(Object.entries(fromForm(p)).filter(([, v]) => v !== undefined)),
        ),
    },
  );

  return {
    resource,
    options: {
      navigation: { name: 'Support', icon: 'Users' },
      sort: { sortBy: 'name', direction: 'asc' },
      listProperties: ['name', 'emailNormalized', 'company', 'isActive'],
      filterProperties: ['name', 'emailNormalized', 'company', 'isActive'],
      properties: {
        id: { isVisible: false },
        name: { isTitle: true },
        createdAt: { isVisible: onlyIn('show') },
        updatedAt: { isVisible: onlyIn('show') },
      },
      actions: { ...NO_DELETE, edit: { isAccessible: adminOnly } },
    },
  };
}

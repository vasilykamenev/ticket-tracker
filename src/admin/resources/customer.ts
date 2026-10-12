import type { ActionContext, ActionRequest, ResourceWithOptions } from 'adminjs';
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import type { CustomerService } from '../../domain/customers/customer-service.js';
import type { TicketQueries } from '../../domain/tickets/ticket-queries.js';
import { Components } from '../component-loader.js';
import { labelled } from '../field-catalog.js';
import { GuardedResource, actorFromContext } from '../guarded-resource.js';
import { NO_DELETE, adminOnly, onlyIn, toggle } from './helpers.js';

const fromForm = (p: Record<string, unknown>) => ({
  name: p.name,
  email: p.emailNormalized,
  company: p.company,
  phone: p.phone,
  isActive: p.isActive,
});

/** Customers are a shared directory: everyone reads and creates, only ADMIN edits or deactivates. */
export function customerResource(prisma: PrismaClient, customers: CustomerService, queries: TicketQueries): ResourceWithOptions {
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
      showProperties: ['name', 'emailNormalized', 'company', 'phone', 'isActive', 'createdAt', 'updatedAt', 'tickets'],
      properties: labelled('Customer', {
        id: { isVisible: false },
        name: { isTitle: true },
        isActive: toggle(),
        createdAt: { isVisible: onlyIn('show') },
        updatedAt: { isVisible: onlyIn('show') },
        // Virtual: the customer's tickets, restricted on the server to the viewer's groups.
        tickets: { type: 'mixed', isVisible: onlyIn('show'), components: { show: Components.CustomerTickets } },
      }),
      actions: {
        ...NO_DELETE,
        edit: { isAccessible: adminOnly },
        customerTickets: {
          actionType: 'record',
          isVisible: false,
          component: false,
          handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => {
            const page = request.query?.page;
            const result = await queries.customerTickets(actorFromContext(context), String(request.params.recordId), Number(typeof page === 'string' ? page : 1));
            // AdminJS requires record actions to return the record; the page data rides along.
            return { record: context.record!.toJSON(context.currentAdmin), ...result };
          },
        },
      },
    },
  };
}

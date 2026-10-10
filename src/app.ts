// Express app assembly. Stage 1 prototype: AdminJS + Prisma resource, no auth yet (stage 3).
import express from 'express';
import AdminJS from 'adminjs';
import AdminJSExpress from '@adminjs/express';
import { Database, Resource, getModelByName } from '@adminjs/prisma';
import { PrismaClient } from '@prisma/client';
import { componentLoader, Components } from './admin/component-loader.js';

AdminJS.registerAdapter({ Database, Resource });

export async function buildApp() {
  const prisma = new PrismaClient();
  const admin = new AdminJS({
    rootPath: '/admin',
    componentLoader,
    resources: [
      // Every model referenced by Ticket must be registered or list/show fail ("no resources with given id").
      // Real restrictions (hidden fields, RBAC) come in stages 3-6.
      { resource: { model: getModelByName('User'), client: prisma }, options: { properties: { passwordHash: { isVisible: false } } } },
      { resource: { model: getModelByName('Agent'), client: prisma }, options: {} },
      { resource: { model: getModelByName('Customer'), client: prisma }, options: {} },
      { resource: { model: getModelByName('SupportGroup'), client: prisma }, options: {} },
      { resource: { model: getModelByName('TicketStatus'), client: prisma }, options: {} },
      {
        resource: { model: getModelByName('Ticket'), client: prisma },
        options: {
          properties: { hello: { isVirtual: true, components: { show: Components.Hello } } },
          showProperties: ['number', 'subject', 'customer', 'group', 'status', 'priority', 'hello'],
        },
      },
    ],
  });
  if (process.env.NODE_ENV === 'production') await admin.initialize();
  else admin.watch();

  const app = express();
  app.get('/health/live', (_req, res) => res.json({ ok: true }));
  app.use(admin.options.rootPath, AdminJSExpress.buildRouter(admin));
  return app;
}

// Express app assembly. Middleware order matters:
//   health -> session -> auth form parser -> CSRF -> /auth routes -> requireUser -> AdminJS router.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import AdminJS from 'adminjs';
import AdminJSExpress from '@adminjs/express';
import { Database, Resource } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { componentLoader } from './admin/component-loader.js';
import { authFormParser, createAuthRouter } from './auth/auth-routes.js';
import { csrfProtection } from './auth/csrf.js';
import { requireUser } from './auth/require-user.js';
import { createSessionMiddleware } from './auth/session.js';
import type { Env } from './config/env.js';
import { agentResource, groupResource, statusResource, userResource } from './admin/resources/reference.js';
import { customerResource } from './admin/resources/customer.js';
import { ticketResource } from './admin/resources/ticket.js';
import { CustomerService } from './domain/customers/customer-service.js';
import { DomainError } from './domain/errors.js';
import { CommentQueries } from './domain/comments/comment-queries.js';
import { CommentService } from './domain/comments/comment-service.js';
import { GroupQueries } from './domain/groups/group-queries.js';
import { GroupService } from './domain/groups/group-service.js';
import { StatusService } from './domain/statuses/status-service.js';
import { AgentService } from './domain/users/agent-service.js';
import { UserService } from './domain/users/user-service.js';
import { TicketQueries } from './domain/tickets/ticket-queries.js';
import { TicketService } from './domain/tickets/ticket-service.js';
import { Components } from './admin/component-loader.js';
import { catalogTranslations } from './admin/field-catalog.js';
import { actorFromContext } from './admin/guarded-resource.js';

AdminJS.registerAdapter({ Database, Resource });

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  sessionPool: pg.Pool;
}

function buildAdmin(prisma: PrismaClient): AdminJS {
  const tickets = new TicketService(prisma);
  const customers = new CustomerService(prisma);
  const queries = new TicketQueries(prisma);
  const groups = new GroupService(prisma);
  const groupQueries = new GroupQueries(prisma);
  const agents = new AgentService(prisma);
  const statuses = new StatusService(prisma);
  const users = new UserService(prisma);
  const comments = new CommentService(prisma);
  const commentQueries = new CommentQueries(prisma);
  return new AdminJS({
    rootPath: '/admin',
    logoutPath: '/auth/logout',
    componentLoader,
    assets: { scripts: ['/auth/csrf-client.js'] },
    settings: { defaultPerPage: 25 },
    // Saved-filter shortcuts with live counts; the handler applies the viewer's scope.
    dashboard: {
      component: Components.Dashboard,
      handler: async (_request, _response, context) => queries.dashboard(actorFromContext(context)),
    },
    locale: {
      language: 'en',
      translations: { en: catalogTranslations() },
    },
    // Every model referenced by Ticket must be registered or list/show fail ("no resources with given id").
    // Registered does not mean writable: see GuardedResource (scope on reads, writes only via services).
    resources: [
      ticketResource(prisma, tickets, queries, comments, commentQueries),
      customerResource(prisma, customers, queries),
      groupResource(prisma, groups, groupQueries),
      agentResource(prisma, agents),
      statusResource(prisma, statuses),
      userResource(prisma, users),
    ],
  });
}

export async function buildApp({ env, prisma, sessionPool }: AppDeps): Promise<express.Express> {
  const admin = buildAdmin(prisma);
  // The bundle is built only when serving real traffic; tests exercise the JSON API.
  if (env.APP_ENV === 'production' || env.APP_ENV === 'demo') await admin.initialize();
  else if (env.APP_ENV === 'development') admin.watch();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  // Health endpoints sit before the session so probes never create sessions.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(createSessionMiddleware(env, sessionPool));
  app.get('/auth/csrf-client.js', (_req, res) => {
    res.type('application/javascript').sendFile(path.join(publicDir, 'csrf-client.js'));
  });
  app.use('/auth', authFormParser);
  app.use(csrfProtection(env.PUBLIC_URL));
  app.use('/auth', createAuthRouter(prisma, env));

  app.use(admin.options.rootPath, requireUser(prisma, env), AdminJSExpress.buildRouter(admin));

  // Domain errors keep their HTTP status; anything else is a 500. Never leak stack traces, URLs or secrets.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    // Error messages (Prisma in particular) can embed submitted data, so log only the error type and code.
    const code = (err as { code?: unknown } | null)?.code;
    console.error('request failed:', err instanceof Error ? err.name : 'unknown', typeof code === 'string' ? code : '');
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);
  return app;
}

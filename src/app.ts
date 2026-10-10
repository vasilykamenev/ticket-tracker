// Express app assembly. Middleware order matters:
//   health -> session -> auth form parser -> CSRF -> /auth routes -> requireUser -> AdminJS router.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import AdminJS from 'adminjs';
import AdminJSExpress from '@adminjs/express';
import { Database, Resource, getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { componentLoader } from './admin/component-loader.js';
import { authFormParser, createAuthRouter } from './auth/auth-routes.js';
import { csrfProtection } from './auth/csrf.js';
import { requireUser } from './auth/require-user.js';
import { createSessionMiddleware } from './auth/session.js';
import type { Env } from './config/env.js';

AdminJS.registerAdapter({ Database, Resource });

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  sessionPool: pg.Pool;
}

function buildAdmin(prisma: PrismaClient): AdminJS {
  return new AdminJS({
    rootPath: '/admin',
    logoutPath: '/auth/logout',
    componentLoader,
    assets: { scripts: ['/auth/csrf-client.js'] },
    resources: [
      // Every model referenced by Ticket must be registered or list/show fail ("no resources with given id").
      // Registration is not exposure: real restrictions (RBAC, hidden fields) arrive in stages 4-6.
      { resource: { model: getModelByName('User'), client: prisma }, options: { properties: { passwordHash: { isVisible: false } } } },
      { resource: { model: getModelByName('Agent'), client: prisma }, options: {} },
      { resource: { model: getModelByName('Customer'), client: prisma }, options: {} },
      { resource: { model: getModelByName('SupportGroup'), client: prisma }, options: {} },
      { resource: { model: getModelByName('TicketStatus'), client: prisma }, options: {} },
      { resource: { model: getModelByName('Ticket'), client: prisma }, options: {} },
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

  // Never leak stack traces, URLs or secrets.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // Error messages (Prisma in particular) can embed submitted data, so log only the error type and code.
    const code = (err as { code?: unknown } | null)?.code;
    console.error('request failed:', err instanceof Error ? err.name : 'unknown', typeof code === 'string' ? code : '');
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);
  return app;
}

import { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';
import { createSessionPool } from './auth/session.js';
import { loadEnv } from './config/env.js';
import { createStorage } from './storage/index.js';

const env = loadEnv();
const prisma = new PrismaClient();
const sessionPool = createSessionPool(env);
const app = await buildApp({ env, prisma, sessionPool, storage: createStorage(env) });

const server = app.listen(env.PORT, () => console.log(`listening on :${env.PORT} (${env.APP_ENV})`));

async function shutdown(): Promise<void> {
  server.close();
  await Promise.allSettled([prisma.$disconnect(), sessionPool.end()]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Builds the AdminJS bundle of the custom components. Run while the Docker image is built (NODE_ENV=production),
// so the container starts in seconds and serves exactly the files that were built; start it with ADMIN_JS_SKIP_BUNDLE=true.
// The bundle is written to .adminjs/ in the working directory. No database connection is made.
import { PrismaClient } from '@prisma/client';
import { buildAdmin } from '../app.js';

if (process.env.NODE_ENV !== 'production') {
  console.error('Run this with NODE_ENV=production: AdminJS builds its bundle only in production mode.');
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  await buildAdmin(prisma).initialize();
  console.log('AdminJS bundle is ready in .adminjs/');
} finally {
  await prisma.$disconnect();
}

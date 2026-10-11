// Bootstraps the first ADMIN. Usage: npm run admin:create -- --email admin@example.test [--name "Display Name"]
// The password is read from ADMIN_PASSWORD or a hidden prompt, never from a CLI argument.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { hashPassword, MAX_PASSWORD_LENGTH } from '../auth/password.js';
import { normalizeEmail } from '../domain/users/email.js';

const MIN_PASSWORD_LENGTH = 12;

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('No TTY: set ADMIN_PASSWORD instead.'));
    process.stdout.write(question);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') return reject(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email) {
  console.error('Usage: npm run admin:create -- --email admin@example.test [--name "Display Name"]');
  process.exit(1);
}

const email = normalizeEmail(values.email);
const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Password: '));
if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
  console.error(`Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  if (await prisma.user.findUnique({ where: { normalizedEmail: email } })) {
    console.error(`User ${email} already exists; nothing changed.`);
    process.exit(1);
  }
  await prisma.user.create({
    data: {
      normalizedEmail: email,
      displayName: values.name ?? email,
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
    },
  });
  console.log(`ADMIN ${email} created.`);
} finally {
  await prisma.$disconnect();
}

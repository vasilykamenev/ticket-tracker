// Stage 1 only: minimal rows to exercise the Ticket resource. Replaced by real seed in stage 10.
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const u = await p.user.upsert({ where: { normalizedEmail: 'proto@example.test' }, update: {}, create: { normalizedEmail: 'proto@example.test', displayName: 'Proto', passwordHash: 'x', role: 'ADMIN' } });
const c = await p.customer.upsert({ where: { emailNormalized: 'c@example.test' }, update: {}, create: { name: 'Customer One', emailNormalized: 'c@example.test' } });
const g = await p.supportGroup.upsert({ where: { code: 'GENERAL' }, update: {}, create: { code: 'GENERAL', name: 'General' } });
const s = await p.ticketStatus.upsert({ where: { code: 'NEW' }, update: {}, create: { code: 'NEW', name: 'New', color: '#3b82f6', sortOrder: 1 } });
await p.ticket.create({ data: { subject: 'Прототип: тестовый тикет', description: 'x', customerId: c.id, groupId: g.id, statusId: s.id, createdByUserId: u.id } });
console.log('ok');
await p.$disconnect();

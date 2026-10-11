import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../../src/auth/password.js';
import { ensureSystemStatuses } from '../../../src/domain/tickets/status-seed.js';
import type { Actor } from '../../../src/policies/ticket-policy.js';

export const TEST_PASSWORD = 'Correct-Horse-9!';

/** Creates uniquely named rows and removes exactly what it created. */
export class Fixtures {
  private passwordHash?: Promise<string>;
  private readonly run = randomUUID().slice(0, 8);
  private n = 0;
  private readonly userIds: string[] = [];
  private readonly groupIds: string[] = [];
  private readonly customerIds: string[] = [];

  constructor(private readonly prisma: PrismaClient) {}

  /** One Argon2 hash shared by every fixture user, so signing in works without slowing tests down. */
  private hash(): Promise<string> {
    this.passwordHash ??= hashPassword(TEST_PASSWORD);
    return this.passwordHash;
  }

  async init(): Promise<void> {
    await ensureSystemStatuses(this.prisma);
  }

  private next(prefix: string): string {
    return `${prefix}-${this.run}-${++this.n}`;
  }

  async group(opts: { active?: boolean } = {}) {
    const code = this.next('G');
    const group = await this.prisma.supportGroup.create({ data: { code, name: code, isActive: opts.active ?? true } });
    this.groupIds.push(group.id);
    return group;
  }

  /** An AGENT user with an Agent profile that belongs to the given groups. */
  async agent(groups: { id: string }[], opts: { active?: boolean } = {}) {
    const name = this.next('agent');
    const user = await this.prisma.user.create({
      data: {
        normalizedEmail: `${name}@example.test`,
        displayName: name,
        passwordHash: await this.hash(),
        role: 'AGENT',
        agent: {
          create: {
            displayName: name,
            isActive: opts.active ?? true,
            groups: { create: groups.map((g) => ({ groupId: g.id })) },
          },
        },
      },
      include: { agent: true },
    });
    this.userIds.push(user.id);
    const actor: Actor = { userId: user.id, role: 'AGENT', agentId: user.agent!.id };
    return { user, agent: user.agent!, actor };
  }

  /** An ADMIN user; optionally with an Agent profile so they can be assigned tickets. */
  async admin(opts: { withAgentIn?: { id: string }[] } = {}) {
    const name = this.next('admin');
    const user = await this.prisma.user.create({
      data: {
        normalizedEmail: `${name}@example.test`,
        displayName: name,
        passwordHash: await this.hash(),
        role: 'ADMIN',
        ...(opts.withAgentIn
          ? { agent: { create: { displayName: name, groups: { create: opts.withAgentIn.map((g) => ({ groupId: g.id })) } } } }
          : {}),
      },
      include: { agent: true },
    });
    this.userIds.push(user.id);
    const actor: Actor = { userId: user.id, role: 'ADMIN', agentId: user.agent?.id ?? null };
    return { user, agent: user.agent, actor };
  }

  async customer(opts: { active?: boolean } = {}) {
    const name = this.next('customer');
    const customer = await this.prisma.customer.create({
      data: { name, emailNormalized: `${name}@example.test`, isActive: opts.active ?? true },
    });
    this.customerIds.push(customer.id);
    return customer;
  }

  /** For rows created by the code under test (not by this class) that must still be cleaned up. */
  trackUser(id: string): void {
    this.userIds.push(id);
  }

  trackGroup(id: string): void {
    this.groupIds.push(id);
  }

  /** A unique email for tests that create accounts through a service. */
  email(prefix: string): string {
    return `${this.next(prefix)}@example.test`;
  }

  async cleanup(): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({
      where: { OR: [{ groupId: { in: this.groupIds } }, { customerId: { in: this.customerIds } }] },
      select: { id: true },
    });
    const ticketIds = tickets.map((t) => t.id);
    await this.prisma.attachment.deleteMany({ where: { comment: { ticketId: { in: ticketIds } } } });
    await this.prisma.comment.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await this.prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await this.prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
    await this.prisma.agentGroup.deleteMany({ where: { groupId: { in: this.groupIds } } });
    await this.prisma.agent.deleteMany({ where: { userId: { in: this.userIds } } });
    await this.prisma.user.deleteMany({ where: { id: { in: this.userIds } } });
    await this.prisma.supportGroup.deleteMany({ where: { id: { in: this.groupIds } } });
    await this.prisma.customer.deleteMany({ where: { id: { in: this.customerIds } } });
  }
}

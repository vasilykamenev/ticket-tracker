import type { Prisma, PrismaClient, Role, User } from '@prisma/client';
import { hashPassword } from '../../auth/password.js';
import { lockActiveAdmins, type Tx } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { parseInput } from '../tickets/schemas.js';
import { deactivateAgentInTx } from './agent-service.js';
import { createUserSchema, passwordField, roleField, updateUserSchema } from './schemas.js';

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may do this');
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
const DUPLICATE_EMAIL = new ValidationError('validation', 'Invalid input', { email: 'a staff account with this email already exists' });

/**
 * Staff accounts. ADMIN only. Rules that matter for security:
 * - role and password change only through their own operations, never through a generic profile edit;
 * - role, password and active state changes bump `sessionVersion`, which signs the user out;
 * - nobody changes their own role or deactivates themselves, so nobody can escalate or lock themselves out;
 * - the last active ADMIN can never be demoted or deactivated (checked under a lock, so concurrent
 *   attempts cannot both succeed);
 * - an AGENT account always has a support profile, and deactivating the account deactivates the
 *   profile, which is refused while the profile holds active tickets.
 */
export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(actor: Actor, userId: string): Promise<User> {
    requireAdmin(actor);
    return this.find(this.prisma, userId);
  }

  async create(actor: Actor, input: unknown): Promise<User> {
    requireAdmin(actor);
    const data = parseInput(createUserSchema, input);
    const passwordHash = await hashPassword(data.password);
    try {
      return await this.prisma.user.create({
        data: {
          normalizedEmail: data.email,
          displayName: data.displayName,
          passwordHash,
          role: data.role,
          // An AGENT must have an active support profile to sign in or be assigned tickets.
          ...(data.role === 'AGENT' ? { agent: { create: { displayName: data.displayName } } } : {}),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw DUPLICATE_EMAIL;
      throw err;
    }
  }

  /** Name, email and active state. Not role, not password. */
  async update(actor: Actor, userId: string, input: unknown): Promise<User> {
    requireAdmin(actor);
    const data = parseInput(updateUserSchema, input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await this.find(tx, userId);
        const changes: Prisma.UserUpdateInput = {};
        if (data.displayName !== undefined && data.displayName !== user.displayName) changes.displayName = data.displayName;
        if (data.email !== undefined && data.email !== user.normalizedEmail) changes.normalizedEmail = data.email;

        if (data.isActive !== undefined && data.isActive !== user.isActive) {
          if (!data.isActive) {
            if (userId === actor.userId) throw new ForbiddenError('self_change', 'You cannot deactivate your own account');
            if (user.role === 'ADMIN') await this.assertNotLastAdmin(tx, userId);
            if (user.agent?.isActive) await deactivateAgentInTx(tx, user.agent.id);
          } else if (user.role === 'AGENT' && user.agent && !user.agent.isActive) {
            await tx.agent.update({ where: { id: user.agent.id }, data: { isActive: true } });
          }
          changes.isActive = data.isActive;
          changes.sessionVersion = { increment: 1 };
        }
        if (Object.keys(changes).length === 0) throw new ValidationError('no_change', 'Nothing to change');

        const updated = await tx.user.update({ where: { id: userId }, data: changes });
        // The support profile shows this name on tickets; keep it in step with a rename.
        if (changes.displayName !== undefined && user.agent) {
          await tx.agent.update({ where: { id: user.agent.id }, data: { displayName: data.displayName! } });
        }
        return updated;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw DUPLICATE_EMAIL;
      throw err;
    }
  }

  async changeRole(actor: Actor, userId: string, role: unknown): Promise<User> {
    requireAdmin(actor);
    const target = parseInput(roleField, role) as Role;
    if (userId === actor.userId) throw new ForbiddenError('self_change', 'You cannot change your own role');
    return this.prisma.$transaction(async (tx) => {
      const user = await this.find(tx, userId);
      if (user.role === target) throw new ValidationError('no_change', 'The account already has this role');
      if (user.role === 'ADMIN' && user.isActive) await this.assertNotLastAdmin(tx, userId);
      if (target === 'AGENT') {
        if (!user.agent) await tx.agent.create({ data: { userId, displayName: user.displayName } });
        else if (!user.agent.isActive && user.isActive) await tx.agent.update({ where: { id: user.agent.id }, data: { isActive: true } });
      }
      return tx.user.update({ where: { id: userId }, data: { role: target, sessionVersion: { increment: 1 } } });
    });
  }

  /** Signs the user out everywhere (sessionVersion bump). Works for any account, including your own. */
  async setPassword(actor: Actor, userId: string, password: unknown): Promise<void> {
    requireAdmin(actor);
    const valid = parseInput(passwordField, password);
    const passwordHash = await hashPassword(valid);
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2025') throw new NotFoundError('user');
      throw err;
    }
  }

  private async find(db: Pick<Tx, 'user'>, userId: string) {
    const user = await db.user.findUnique({ where: { id: userId }, include: { agent: true } });
    if (!user) throw new NotFoundError('user');
    return user;
  }

  private async assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
    const admins = await lockActiveAdmins(tx);
    if (!admins.some((id) => id !== userId)) {
      throw new ConflictError('last_admin', 'This is the last active administrator; promote another one first');
    }
  }
}

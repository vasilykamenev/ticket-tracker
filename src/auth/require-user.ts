import type { Agent, PrismaClient, User } from '@prisma/client';
import type { Request, RequestHandler, Response } from 'express';
import type { Env } from '../config/env.js';
import type { SessionUser } from '../types/express-session.js';

export type UserWithAgent = User & { agent: Agent | null };

export function toSessionUser(user: UserWithAgent): SessionUser {
  return {
    id: user.id,
    email: user.normalizedEmail,
    title: user.displayName,
    role: user.role,
    agentId: user.agent?.id ?? null,
  };
}

/** A user may sign in only if active; an AGENT also needs an active Agent profile. */
export function canSignIn(user: UserWithAgent): boolean {
  return user.isActive && (user.role === 'ADMIN' || user.agent?.isActive === true);
}

function wantsJson(req: Request): boolean {
  return req.originalUrl.startsWith('/admin/api') || req.get('accept')?.includes('application/json') === true;
}

function reject(req: Request, res: Response): void {
  req.session.destroy(() => {
    res.clearCookie('sid');
    if (wantsJson(req)) res.status(401).json({ error: 'unauthenticated' });
    else res.redirect(302, '/auth/login');
  });
}

/**
 * Loads the user from the database on every request, so deactivation, role
 * changes and sessionVersion bumps take effect on the next request.
 */
export function requireUser(prisma: PrismaClient, env: Env): RequestHandler {
  const absoluteMs = env.SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000;
  return async (req, res, next) => {
    try {
      const { userId, sessionVersion, authAt } = req.session;
      if (!userId || authAt === undefined || Date.now() - authAt > absoluteMs) return reject(req, res);
      const user = await prisma.user.findUnique({ where: { id: userId }, include: { agent: true } });
      if (!user || user.sessionVersion !== sessionVersion || !canSignIn(user)) return reject(req, res);
      req.user = toSessionUser(user);
      req.session.adminUser = req.user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

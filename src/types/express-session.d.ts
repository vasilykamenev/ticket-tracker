import 'express-session';

export interface SessionUser {
  id: string;
  email: string;
  title: string;
  role: 'ADMIN' | 'AGENT';
  agentId: string | null;
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
    sessionVersion: number;
    /** epoch ms of login; basis of the absolute session lifetime */
    authAt: number;
    csrfToken: string;
    /** set while the person is at the OAuth provider; used once by the callback */
    oauth: { provider: 'google' | 'github'; state: string; verifier: string; at: number };
    /** read by @adminjs/express as currentAdmin */
    adminUser: SessionUser;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

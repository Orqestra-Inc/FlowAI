import type { NextFunction, Request, Response } from 'express';
import type { DB } from './db.js';
import type { Actor, Role } from './domain/types.js';

export const SESSION_COOKIE = 'orq_session';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
  }
}

interface UserRow { id: string; email: string; business_id: string; role: Role; display_name: string }

export function actorFor(db: DB, userId: string): Actor | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  return row ? { userId: row.id, email: row.email, businessId: row.business_id, role: row.role, displayName: row.display_name } : null;
}

export function actorByEmail(db: DB, email: string): Actor | null {
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: string } | undefined;
  return row ? actorFor(db, row.id) : null;
}

/** Identity comes ONLY from the signed, httpOnly session cookie — never from the request body or tool arguments. */
export function requireActor(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = req.signedCookies?.[SESSION_COOKIE];
    const actor = typeof userId === 'string' ? actorFor(db, userId) : null;
    if (!actor) {
      res.status(401).json({ error: 'Not signed in.' });
      return;
    }
    req.actor = actor;
    next();
  };
}

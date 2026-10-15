export type Role = 'owner' | 'procurement' | 'accountant';

/** Who is acting. Always resolved on the server from the session, never from model or client input. */
export interface Actor {
  userId: string;
  email: string;
  businessId: string;
  role: Role;
  displayName: string;
}

/** A refusal by deterministic business rules (not by ArmorIQ). */
export class DomainRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DomainRefusal';
  }
}

export function refuse(code: string, message: string): never {
  throw new DomainRefusal(code, message);
}

export function requireRole(actor: Actor, allowed: Role[], what: string): void {
  if (!allowed.includes(actor.role)) {
    refuse('role_not_permitted', `${actor.role} is not permitted to ${what}. Allowed: ${allowed.join(', ')}.`);
  }
}

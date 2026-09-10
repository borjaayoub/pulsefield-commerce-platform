import type { ActorType } from '@pulse-field/contracts';
import { AuditAccessDeniedError } from './audit.errors';

export const AUDIT_RECENT_AUTHENTICATION_MS = 10 * 60_000;

export interface AuditReaderContext {
  actor: {
    type: ActorType;
    id: string;
    roles: string[];
  };
  authenticationAssurance: 'PASSWORD' | 'PASSWORD_MFA';
  authenticatedAt: Date;
}

export function assertAuditReader(context: AuditReaderContext, now = new Date()): void {
  const authenticatedAt = context?.authenticatedAt;
  const validAuthenticatedAt =
    authenticatedAt instanceof Date && Number.isFinite(authenticatedAt.getTime());
  const age = validAuthenticatedAt ? now.getTime() - authenticatedAt.getTime() : Number.NaN;
  if (
    context?.actor?.type !== 'staff' ||
    typeof context.actor.id !== 'string' ||
    context.actor.id.trim().length === 0 ||
    !Array.isArray(context.actor.roles) ||
    !context.actor.roles.includes('ADMINISTRATOR') ||
    context.authenticationAssurance !== 'PASSWORD_MFA' ||
    !validAuthenticatedAt ||
    age < 0 ||
    age > AUDIT_RECENT_AUTHENTICATION_MS
  ) {
    throw new AuditAccessDeniedError();
  }
}

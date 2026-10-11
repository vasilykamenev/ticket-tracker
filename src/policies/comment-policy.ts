// Comment permissions, requirements section 7. Pure functions of the actor and the ticket status.
import { isStatusCode, isFrozen } from '../domain/tickets/workflow.js';
import { type Actor, isAdmin } from './ticket-policy.js';

/** CLOSED and UNRESOLVED tickets take no new comments until reopened. An unknown status fails closed. */
export function canAddComment(statusCode: string): boolean {
  return isStatusCode(statusCode) && !isFrozen(statusCode);
}

/** ADMIN edits any comment, an AGENT only their own; nobody edits on a CLOSED or UNRESOLVED ticket. */
export function canEditComment(actor: Actor, authorUserId: string, statusCode: string): boolean {
  return canAddComment(statusCode) && (isAdmin(actor) || actor.userId === authorUserId);
}

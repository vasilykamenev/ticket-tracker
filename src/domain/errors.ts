/** Errors thrown by domain services. The HTTP/AdminJS layer maps `status` and never leaks internals. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Also used for records outside the actor's scope, so existence is not disclosed. */
export class NotFoundError extends DomainError {
  constructor(what = 'record') {
    super('not_found', 404, `${what} not found`);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code = 'forbidden', message = 'Operation is not permitted') {
    super(code, 403, message);
  }
}

/** Version mismatch (409, user should refresh) or a state that forbids the operation. */
export class ConflictError extends DomainError {
  constructor(code: 'version_conflict' | 'ticket_frozen' | 'has_active_tickets' | 'last_admin' | 'status_in_use', message: string) {
    super(code, 409, message);
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, string>) {
    super(code, 422, message, details);
  }
}

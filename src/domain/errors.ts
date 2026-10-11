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
  constructor(code: 'version_conflict' | 'ticket_frozen' | 'has_active_tickets' | 'last_admin' | 'status_in_use' | 'attachment_limit', message: string) {
    super(code, 409, message);
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, string>) {
    super(code, 422, message, details);
  }
}

/** The uploaded file is bigger than the limit (HTTP 413). */
export class PayloadTooLargeError extends DomainError {
  constructor(message: string) {
    super('file_too_large', 413, message);
  }
}

/** The file is not one of the accepted kinds, or its content does not match what it claims to be (HTTP 415). */
export class UnsupportedMediaError extends DomainError {
  constructor(message: string) {
    super('unsupported_file', 415, message);
  }
}

/** The object store failed. Deliberately generic: never carries endpoints, keys or provider messages (HTTP 502). */
export class StorageError extends DomainError {
  constructor() {
    super('storage_unavailable', 502, 'File storage is temporarily unavailable. Please try again.');
  }
}

/** Too many uploads are being processed at once (HTTP 429). */
export class BusyError extends DomainError {
  constructor() {
    super('busy', 429, 'Too many uploads are in progress. Please try again in a moment.');
  }
}

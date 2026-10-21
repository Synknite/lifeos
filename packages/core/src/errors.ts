/** Errors thrown by services; the API maps `status` straight to HTTP. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string) {
    super(`${entity} not found`, 'not_found', 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'conflict', 409);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication required') {
    super(message, 'unauthorized', 401);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'validation_error', 400);
  }
}

export class RateLimitedError extends DomainError {
  constructor(message: string) {
    super(message, 'rate_limited', 429);
  }
}

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

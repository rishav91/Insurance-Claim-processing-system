/**
 * Typed service errors so the HTTP layer can map domain failures to status codes
 * (docs/api.md) without leaking Prisma/transport details into the service.
 *
 *  - NotFoundError  → 404 (unknown id)
 *  - ConflictError  → 409 (illegal state transition)
 *  - ValidationError→ 422 (well-formed but semantically invalid)
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  details: { path: string; issue: string }[];
  constructor(message: string, details: { path: string; issue: string }[] = []) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

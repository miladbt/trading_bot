/**
 * Typed errors for the domain layer. Throwing domain errors (rather than
 * returning errors) keeps pure constructors ergonomic; the Result type is used
 * where failure is an expected part of a flow.
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** A constructor/parse received a value that violates a domain invariant. */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** A state transition was attempted that the current state forbids. */
export class InvalidTransitionError extends DomainError {
  constructor(
    public readonly from: string,
    public readonly to: string,
    what: string,
  ) {
    super(`Invalid ${what} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

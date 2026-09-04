/** Machine-readable discriminant for errors DocSync itself produces. */
export type DocSyncErrorType =
  | "AuthorizationError"
  | "ConnectionError"
  | "DatabaseError"
  | "NetworkError"
  | "ValidationError";

/**
 * Error raised by DocSync, carrying a `type` so applications can branch on the
 * failure without matching on `message`.
 *
 * Failures thrown by application-provided code (the local provider, the doc
 * binding) are surfaced unchanged so their original stack survives. Narrow with
 * `instanceof DocSyncError` before reading `type`.
 */
export class DocSyncError extends Error {
  readonly type: DocSyncErrorType;

  constructor(type: DocSyncErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = type;
    this.type = type;
  }
}

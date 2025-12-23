import type { Operations } from "docnode";
import type { AuthorizeEvent } from "../shared/types.js";

// replace this with shared types
export type ServerProvider = {
  saveOperations: (operations: Operations) => Promise<void>;
};

/**
 * Server configuration with generic context type.
 *
 * @typeParam TContext - Application-defined context shape returned by authenticate
 *                       and passed to authorize. Defaults to empty object.
 */
export type ServerConfig<
  TContext = Record<string, unknown>,
  S = unknown,
  O = unknown,
> = {
  port?: number;
  provider: new () => ServerProvider;

  /**
   * Authenticates a WebSocket connection.
   *
   * - Called once per connection attempt.
   * - Must validate the provided token.
   * - Must resolve the canonical userId.
   * - May optionally return a context object that will be passed to authorize.
   *
   * @returns User info with optional context, or undefined if authentication fails.
   */
  authenticate: (ev: { token: string }) => Promise<
    | {
        userId: string;
        context?: TContext;
      }
    | undefined
  >;

  /**
   * Authorizes an operation.
   *
   * - Called for each operation (get-doc, apply-operations, create-doc, save-doc).
   * - Receives the cached context from authenticate.
   * - Can use cached context for fast checks or fetch fresh data for consistency.
   *
   * @returns true to allow, false to deny.
   */
  authorize?: (ev: AuthorizeEvent<TContext, S, O>) => Promise<boolean>;
};

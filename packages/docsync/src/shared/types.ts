// TODO: review this line! Importing socket.io and socket.io-client
// as dynamic imports produces environment pollution errors.
import type { DeleteDocHandler } from "../server/handlers/deleteDoc.js";
import type { PresenceHandler } from "../server/handlers/presence.js";
import type { SyncHandler } from "../server/handlers/sync.js";
import type { UnsubscribeDocHandler } from "../server/handlers/unsubscribe.js";

/**
 * DocSync Type Definitions
 *
 * This file contains all type definitions for the DocSync library.
 */

// TO-DECIDE: should params in fn's be objects?
export interface DocBinding<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> {
  // method syntax is required to avoid type errors
  create(type: string, id?: string): { doc: D; docId: string };
  deserialize(serializedDoc: S): D;
  serialize(doc: D): S;
  onChange(
    doc: D,
    cb: (ev: { operations: O; flags?: TransactionFlags }) => void,
  ): void;
  applyOperations(doc: D, operations: O, flags?: TransactionFlags): void;
  dispose(doc: D): void;
}

// Keep this local instead of importing from @docukit/docnode because DocNode is
// an optional peer dependency of @docukit/docsync.
export type TransactionFlags = { skipUndo?: boolean };

// ============================================================================
// Utility Types
// ============================================================================

export type MaybePromise<T> = T | Promise<T>;

// ============================================================================
// Monads
// ============================================================================

export type Result<D, E = Error> =
  | { data: D; error?: never }
  | { data?: never; error: E };

// ============================================================================
// DocSync Events (Request/Response)
// ============================================================================

/** Shared request payload for the sync event (client sends, server receives). */
export type SyncRequest<O = unknown> = {
  type: string;
  docId: string;
  operations?: O[];
  clock: number;
};

/** Shared response for the sync event (server sends, client receives). */
export type SyncResponse<S = unknown, O = unknown> = Result<
  { docId: string; operations?: O[]; serializedDoc?: S; clock: number },
  {
    type: "AuthorizationError" | "DatabaseError" | "ValidationError";
    message: string;
  }
>;

/** Shared request/response for the presence event. */
export type PresenceRequest = { docId: string; presence: unknown };
export type PresenceResponse = Result<
  void,
  { type: "AuthorizationError"; message: string }
>;

/** Shared request/response for the delete-doc event. */
export type DeleteDocRequest = { docId: string };
export type DeleteDocResponse = { success: boolean };

/** Shared request/response for the unsubscribe-doc event. */
export type UnsubscribeDocRequest = { docId: string };
export type UnsubscribeDocResponse = { success: boolean };

export type DocSyncEventName =
  | "sync"
  | "presence"
  | "delete-doc"
  | "unsubscribe-doc";

// ============================================================================
// Presence (shared)
// ============================================================================

/**
 * Presence is a record of user IDs to their presence data.
 * It is used to track the presence of users in a document.
 */
export type Presence<T = unknown> = Record<string, T>;

// ============================================================================
// Provider Types (shared payload only; Provider/Context are in client/types and server/types)
// ============================================================================

export type SerializedDocPayload<S> = {
  serializedDoc: S;
  docId: string;
  clock: number;
};

// ============================================================================
// Socket.IO Types
// ============================================================================

/**
 * Socket.IO type definitions derived from DocSync events.
 */

export type ClientToServerEvents<S, O> = {
  sync: SyncHandler<S, O>;
  presence: PresenceHandler;
  "delete-doc": DeleteDocHandler;
  "unsubscribe-doc": UnsubscribeDocHandler;
};

export type ServerToClientEvents = {
  // Server notifies clients that a document has been modified
  dirty: (payload: { docId: string }) => void;
  // Server notifies clients whether another user is online in the same document
  collaboration: (payload: {
    docId: string;
    hasCollaborators: boolean;
  }) => void;
  // Server notifies clients about presence updates
  presence: (payload: { docId: string; presence: Presence }) => void;
};

/* eslint-disable @typescript-eslint/no-restricted-types */
import { type Server } from "socket.io";
import { type Socket } from "socket.io-client";

// ============================================================================
// Helper types for client
// ============================================================================
// TODO: review these types
export type OpsPayload<O> = { docId: string; operations: O };

export type SerializedDocPayload<S> = {
  serializedDoc: S;
  docId: string;
  clock: number;
};

// ============================================================================
// DocSync events
// ============================================================================
// TODO: zod?
// these are request to the server or indexedDB?
export type DocSyncEvents<S, O> = {
  "get-doc": {
    request: { docId: string };
    response: { serializedDoc: S; clock: number } | undefined;
  };
  // prettier-ignore
  "sync-operations": {
    request: { docId: string; operations: O[] | null; clock: number };
    response: { docId: string; operations: O[] | null; serializedDoc: S | null; clock: number };
  };
  "delete-doc": {
    request: { docId: string };
    response: { success: boolean };
  };
  // Client unsubscribes from document updates
  "unsubscribe-doc": {
    request: { docId: string };
    response: { success: boolean };
  };
};

export type DocSyncEventName = keyof DocSyncEvents<unknown, unknown>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type AuthorizeEvent<TContext = {}, S = unknown, O = unknown> = {
  [K in DocSyncEventName]: {
    type: K;
    payload: DocSyncEvents<S, O>[K]["request"];
    userId: string;
    context: TContext;
  };
}[DocSyncEventName];

// ============================================================================
// Socket.io Types (derived from events)
// ============================================================================

type ClientToServerEvents<S, O> = {
  [K in DocSyncEventName]: (
    payload: DocSyncEvents<S, O>[K]["request"],
    cb: (res: DocSyncEvents<S, O>[K]["response"]) => void,
  ) => void;
};

type ServerToClientEvents = {
  // Server notifies clients that a document has been modified
  dirty: (payload: { docId: string }) => void;
  // Server sends debug logs to clients (for testing/debugging)
  _log: (arg: unknown) => void;
};

export type ServerSocket<S, O> = Server<
  ClientToServerEvents<S, O>,
  ServerToClientEvents
>;

export type ClientSocket<S, O> = Socket<
  ServerToClientEvents,
  ClientToServerEvents<S, O>
>;

/**
 * Server socket event handlers type - TypeScript errors if any event is missing.
 */
export type SocketHandlers<S, O> = {
  [K in DocSyncEventName]: (
    payload: DocSyncEvents<S, O>[K]["request"],
    cb: (res: DocSyncEvents<S, O>[K]["response"]) => void,
  ) => void | Promise<void>;
};

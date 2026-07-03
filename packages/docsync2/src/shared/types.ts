import type { DeleteDocHandler } from "../server/handlers/deleteDoc.js";
import type { PresenceHandler } from "../server/handlers/presence.js";
import type { SyncHandler } from "../server/handlers/sync.js";
import type { UnsubscribeDocHandler } from "../server/handlers/unsubscribe.js";
import type * as v from "valibot";
import type {
  collaborationPayloadSchema,
  deleteDocRequestSchema,
  deleteDocResponseErrorSchema,
  dirtyPayloadSchema,
  docSyncEventNameSchema,
  emptyResponseDataSchema,
  presencePayloadSchema,
  presenceRequestSchema,
  presenceResponseSchema,
  presenceSchema,
  serializedDocPayloadSchema,
  syncRequestSchema,
  syncResponseDataSchema,
  syncResponseErrorSchema,
  unsubscribeDocRequestSchema,
  unsubscribeDocResponseErrorSchema,
} from "./validators/socketProtocol.js";

export type MaybePromise<T> = T | Promise<T>;

export type Presence<T = unknown> = v.InferOutput<typeof presenceSchema> &
  Record<string, T>;

export type Result<D, E = Error> =
  | { data: D; error?: never }
  | { data?: never; error: E };

export type SyncRequest<S = unknown, O = unknown> = v.InferOutput<
  typeof syncRequestSchema
> & { operations: O[]; serializedDoc?: S | undefined };

export type SyncResponse<S = unknown, O = unknown> = Result<
  v.InferOutput<typeof syncResponseDataSchema> & {
    operations: O[];
    serializedDoc: S | null;
  },
  v.InferOutput<typeof syncResponseErrorSchema>
>;

export type PresenceRequest = v.InferOutput<typeof presenceRequestSchema>;
export type PresenceResponse = v.InferOutput<typeof presenceResponseSchema>;

export type DeleteDocRequest = v.InferOutput<typeof deleteDocRequestSchema>;
export type DeleteDocResponse = Result<
  v.InferOutput<typeof emptyResponseDataSchema>,
  v.InferOutput<typeof deleteDocResponseErrorSchema>
>;

export type UnsubscribeDocRequest = v.InferOutput<
  typeof unsubscribeDocRequestSchema
>;
export type UnsubscribeDocResponse = Result<
  v.InferOutput<typeof emptyResponseDataSchema>,
  v.InferOutput<typeof unsubscribeDocResponseErrorSchema>
>;

export type DocSyncEventName = v.InferOutput<typeof docSyncEventNameSchema>;

export type SerializedDocPayload<S extends object = object> = v.InferOutput<
  typeof serializedDocPayloadSchema
> & { serializedDoc: S };

type DirtyPayload = v.InferOutput<typeof dirtyPayloadSchema>;
type CollaborationPayload = v.InferOutput<typeof collaborationPayloadSchema>;
type PresencePayload = v.InferOutput<typeof presencePayloadSchema>;

export type IdentityPayload = { userId: string };

export type ClientToServerEvents<S extends object, O extends object> = {
  sync: SyncHandler<S, O>;
  presence: PresenceHandler;
  "delete-doc": DeleteDocHandler;
  "unsubscribe-doc": UnsubscribeDocHandler;
};

export type ServerToClientEvents = {
  identity: (payload: IdentityPayload) => void;
  dirty: (payload: DirtyPayload) => void;
  collaboration: (payload: CollaborationPayload) => void;
  presence: (payload: PresencePayload) => void;
};

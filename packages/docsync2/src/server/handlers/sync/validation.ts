import * as v from "valibot";
import type { SyncResponse } from "../../../shared/types.js";
import type { DocSyncServer } from "../../index.js";
import type { ServerConnectionSocket } from "../../types.js";

const syncEnvelopeSchema = v.object({
  type: v.string(),
  docId: v.string(),
  operations: v.optional(v.array(v.unknown())),
  clock: v.number(),
});

type SyncValidationContext<
  TContext extends object,
  S extends object,
  O extends object,
> = {
  server: DocSyncServer<TContext, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  req: unknown;
  cb: (res: SyncResponse<S, O>) => void;
  startTime: number;
};

export const createSyncValidation = <
  TContext extends object,
  S extends object,
  O extends object,
>(
  context: SyncValidationContext<TContext, S, O>,
) => {
  return {
    envelope() {
      try {
        const envelope = v.parse(syncEnvelopeSchema, context.req);
        return {
          type: envelope.type,
          docId: envelope.docId,
          ...(envelope.operations !== undefined
            ? { operations: envelope.operations }
            : {}),
          clock: envelope.clock,
        };
      } catch (error) {
        respondValidationError(context, error);
      }
    },

    operations(req: v.InferOutput<typeof syncEnvelopeSchema>) {
      try {
        return (req.operations ?? []).map((operation) =>
          context.server["_validators"].operations(operation),
        );
      } catch (error) {
        respondValidationError(context, error);
      }
    },

    stored({
      docId,
      operations: rawOperations,
      serializedDoc: rawSerializedDoc,
      clock,
    }: {
      docId: string;
      operations: unknown[];
      serializedDoc?: unknown;
      clock: number;
    }) {
      try {
        const operations = rawOperations.map((operation) =>
          context.server["_validators"].operations(operation),
        );
        const serializedDoc =
          rawSerializedDoc === undefined
            ? undefined
            : context.server["_validators"].serializedDoc(rawSerializedDoc);

        return {
          docId,
          ...(operations.length > 0 ? { operations } : {}),
          ...(serializedDoc !== undefined ? { serializedDoc } : {}),
          clock,
        };
      } catch (error) {
        respondValidationError(context, error);
      }
    },
  };
};

const respondValidationError = <
  TContext extends object,
  S extends object,
  O extends object,
>(
  { server, socket, req, cb, startTime }: SyncValidationContext<TContext, S, O>,
  error: unknown,
) => {
  const { userId, deviceId } = socket.data;
  const errorEvent = {
    type: "ValidationError" as const,
    message: error instanceof Error ? error.message : String(error),
  };

  server["_emit"](server["_syncRequestEventListeners"], {
    userId,
    deviceId,
    socketId: socket.id,
    status: "error",
    req,
    error: errorEvent,
    durationMs: Date.now() - startTime,
  });

  cb({ error: errorEvent });
};

import * as v from "valibot";
import type { SyncResponse } from "../../../shared/types.js";
import type { DocSyncServer } from "../../index.js";
import type { ServerConnectionSocket } from "../../types.js";
import { syncRequestSchema } from "../../../shared/validators/socketProtocol.js";
import { createValidationError } from "../validation.js";

type SyncEnvelope = v.InferOutput<typeof syncRequestSchema>;

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
        return v.parse(syncRequestSchema, context.req);
      } catch (error) {
        respondValidationError(context, error);
      }
    },

    operations(req: SyncEnvelope) {
      try {
        return req.operations.map((operation) =>
          context.server["_validators"].operations(operation),
        );
      } catch (error) {
        respondValidationError(context, error);
      }
    },

    serializedDoc(req: SyncEnvelope) {
      try {
        return req.serializedDoc === undefined
          ? undefined
          : context.server["_validators"].serializedDoc(req.serializedDoc);
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
            ? null
            : context.server["_validators"].serializedDoc(rawSerializedDoc);

        return { docId, operations, serializedDoc, clock };
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
  const { userId, deviceId, clientId } = socket.data;
  const errorEvent = createValidationError(error);

  server["_emit"](server["_syncRequestEventListeners"], {
    userId,
    deviceId,
    clientId,
    status: "error",
    req,
    error: errorEvent,
    durationMs: Date.now() - startTime,
  });

  cb({ error: errorEvent });
};

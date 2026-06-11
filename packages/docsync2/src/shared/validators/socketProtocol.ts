import * as v from "valibot";

export const docSyncEventNameSchema = v.union([
  v.literal("sync"),
  v.literal("presence"),
  v.literal("delete-doc"),
  v.literal("unsubscribe-doc"),
]);

export const socketAuthSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
  deviceId: v.pipe(v.string(), v.minLength(1)),
  clientId: v.pipe(v.string(), v.minLength(1)),
});

export const presenceSchema = v.record(v.string(), v.unknown());

export const syncRequestSchema = v.object({
  type: v.string(),
  docId: v.string(),
  operations: v.optional(v.array(v.unknown())),
  clock: v.number(),
});

export const syncResponseDataSchema = v.object({
  docId: v.string(),
  operations: v.optional(v.array(v.unknown())),
  serializedDoc: v.optional(v.unknown()),
  clock: v.number(),
});

export const syncResponseErrorSchema = v.object({
  type: v.union([
    v.literal("AuthorizationError"),
    v.literal("DatabaseError"),
    v.literal("ValidationError"),
  ]),
  message: v.string(),
});

export const syncResponseSchema = v.union([
  v.object({ data: syncResponseDataSchema }),
  v.object({ error: syncResponseErrorSchema }),
]);

export const presenceRequestSchema = v.object({
  docId: v.string(),
  presence: v.unknown(),
});

export const emptyResponseDataSchema = v.undefined_();

export const presenceResponseErrorSchema = v.object({
  type: v.union([
    v.literal("AuthorizationError"),
    v.literal("ValidationError"),
  ]),
  message: v.string(),
});

export const presenceResponseSchema = v.union([
  v.object({ data: emptyResponseDataSchema }),
  v.object({ error: presenceResponseErrorSchema }),
]);

export const deleteDocRequestSchema = v.object({ docId: v.string() });

export const deleteDocResponseErrorSchema = v.object({
  type: v.union([
    v.literal("AuthorizationError"),
    v.literal("ValidationError"),
  ]),
  message: v.string(),
});

export const deleteDocResponseSchema = v.union([
  v.object({ data: emptyResponseDataSchema }),
  v.object({ error: deleteDocResponseErrorSchema }),
]);

export const unsubscribeDocRequestSchema = v.object({ docId: v.string() });

export const unsubscribeDocResponseErrorSchema = v.object({
  type: v.literal("ValidationError"),
  message: v.string(),
});

export const unsubscribeDocResponseSchema = v.union([
  v.object({ data: emptyResponseDataSchema }),
  v.object({ error: unsubscribeDocResponseErrorSchema }),
]);

export const serializedDocPayloadSchema = v.object({
  serializedDoc: v.unknown(),
  docId: v.string(),
  clock: v.number(),
});

export const dirtyPayloadSchema = v.object({ docId: v.string() });

export const collaborationPayloadSchema = v.object({
  docId: v.string(),
  hasCollaborators: v.boolean(),
});

export const presencePayloadSchema = v.object({
  docId: v.string(),
  presence: presenceSchema,
});

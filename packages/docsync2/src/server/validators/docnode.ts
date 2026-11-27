import type { Json, JsonDoc, Operations } from "@docukit/docnode";
import * as v from "valibot";

/** A node: a number (of the batch head's session), a whole id, or `0`. */
const nodeRefSchema = v.union([v.string(), v.pipe(v.number(), v.integer())]);

const insertedNodesSchema = v.array(
  v.union([
    v.tuple([nodeRefSchema, v.string()]),
    v.tuple([nodeRefSchema, v.string(), v.pipe(v.number(), v.integer())]),
  ]),
);

/** A row of a batch (see `Operations` in `@docukit/docnode`). */
const rowSchema = v.union([
  v.tuple([
    v.literal(0),
    insertedNodesSchema,
    nodeRefSchema,
    nodeRefSchema,
    nodeRefSchema,
  ]),
  v.tuple([v.literal(1), nodeRefSchema, nodeRefSchema]),
  v.tuple([
    v.literal(2),
    nodeRefSchema,
    nodeRefSchema,
    nodeRefSchema,
    nodeRefSchema,
    nodeRefSchema,
  ]),
  v.tuple([
    v.literal(-9),
    v.array(nodeRefSchema),
    v.array(v.string()),
    v.array(v.lazy(() => jsonSchema)),
  ]),
]);

/** `[head, ...rows]`. */
const operationsSchema = v.tupleWithRest([v.string()], rowSchema);

const jsonSchema: v.GenericSchema<unknown, Json> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(jsonSchema),
    v.record(v.string(), jsonSchema),
  ]),
);

const stateSchema = v.record(v.string(), jsonSchema);

// Strict: a plain tuple drops extra items, so the shape of a root without
// children would match any document and keep only its root.
const serializedDocSchema: v.GenericSchema<unknown, JsonDoc> = v.union([
  v.strictTuple([v.string(), v.string(), stateSchema]),
  v.strictTuple([
    v.string(),
    v.string(),
    stateSchema,
    v.array(v.tupleWithRest([v.string()], v.string())),
    v.array(v.number()),
    v.array(v.number()),
    v.array(v.number()),
    v.array(jsonSchema),
    v.array(v.string()),
    v.array(v.union([v.number(), v.string()])),
  ]),
]);

export const DocNodeValidators = () => {
  return {
    serializedDoc(input: unknown): JsonDoc {
      return v.parse(serializedDocSchema, input);
    },
    operations(input: unknown): Operations {
      return v.parse(operationsSchema, input);
    },
  };
};

import type { Json, JsonDoc, Operations } from "@docukit/docnode";
import * as v from "valibot";

const stringRecordSchema = v.record(v.string(), v.string());
const stringOrZeroSchema = v.union([v.string(), v.literal(0)]);

const nodeReferenceSchema = v.tuple([v.string(), v.string()]);

const insertOperationSchema = v.tuple([
  v.literal(0),
  v.array(nodeReferenceSchema),
  stringOrZeroSchema,
  stringOrZeroSchema,
  stringOrZeroSchema,
]);

const deleteOperationSchema = v.tuple([
  v.literal(1),
  v.string(),
  stringOrZeroSchema,
]);

const moveOperationSchema = v.tuple([
  v.literal(2),
  v.string(),
  stringOrZeroSchema,
  stringOrZeroSchema,
  stringOrZeroSchema,
  stringOrZeroSchema,
]);

const orderedOperationSchema = v.union([
  insertOperationSchema,
  deleteOperationSchema,
  moveOperationSchema,
]);

const operationsSchema = v.tuple([
  v.array(orderedOperationSchema),
  v.record(v.string(), stringRecordSchema),
]);

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

const serializedDocSchema: v.GenericSchema<unknown, JsonDoc> = v.union([
  v.tuple([v.string(), v.string(), stateSchema]),
  v.tuple([
    v.string(),
    v.string(),
    stateSchema,
    v.array(v.string()),
    v.array(v.number()),
    v.array(v.number()),
    v.array(stateSchema),
    v.array(v.string()),
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

import type { JsonDoc, Operations } from "@docukit/docnode";
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

const serializedDocSchema: v.GenericSchema<unknown, JsonDoc> = v.lazy(() => {
  const childrenSchema = v.tupleWithRest(
    [serializedDocSchema],
    serializedDocSchema,
  );

  return v.union([
    v.tuple([v.string(), v.string(), stringRecordSchema]),
    v.tuple([v.string(), v.string(), stringRecordSchema, childrenSchema]),
  ]);
});

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

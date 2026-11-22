import type { Json, JsonDoc, Operations } from "@docukit/docnode";
import * as v from "valibot";

const jsonSchema: v.GenericSchema<Json> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(jsonSchema),
    v.record(v.string(), jsonSchema),
  ]),
);

/** Each value as a JSON string. */
const treeStateSchema = v.record(v.string(), v.string());

/** `[id, type, state, children?]`: see `JsonDoc` in `@docukit/docnode`. */
const jsonTreeSchema: v.GenericSchema<unknown, JsonDoc> = v.lazy(() => {
  const childrenSchema = v.tupleWithRest([jsonTreeSchema], jsonTreeSchema);

  return v.union([
    v.tuple([v.string(), v.string(), treeStateSchema]),
    v.tuple([v.string(), v.string(), treeStateSchema, childrenSchema]),
  ]);
});

const headSchema = v.union([v.string(), v.array(v.string())]);
/** A node: a string, a number (its distance from the head's counter), or `0`. */
const nodeRefSchema = v.union([v.string(), v.pipe(v.number(), v.integer())]);
const nodesSchema = v.array(v.tuple([nodeRefSchema, v.string()]));

/** Each row of a batch (see `Operations` in `@docukit/docnode`). */
const rowSchema = v.union([
  v.tupleWithRest([v.literal(0), nodesSchema], nodeRefSchema),
  v.tupleWithRest([v.literal(0), nodeRefSchema, v.string()], nodeRefSchema),
  v.tupleWithRest([v.literal(1)], nodeRefSchema),
  v.tupleWithRest([v.literal(2), nodeRefSchema], nodeRefSchema),
  v.tupleWithRest([v.literal(-9)], jsonSchema),
]);

/** `[head, ...rows]`, or `[head, ...row]` for a batch of one row. */
const operationsSchema = v.union([
  v.tupleWithRest([headSchema], rowSchema),
  v.tupleWithRest([headSchema, v.literal(0), nodesSchema], nodeRefSchema),
  v.tupleWithRest(
    [headSchema, v.literal(0), nodeRefSchema, v.string()],
    nodeRefSchema,
  ),
  v.tupleWithRest([headSchema, v.literal(1)], nodeRefSchema),
  v.tupleWithRest([headSchema, v.literal(2), nodeRefSchema], nodeRefSchema),
  v.tupleWithRest([headSchema, v.literal(-9)], jsonSchema),
]);

/** What `Doc.fromJSON` reads. */
const serializedDocSchema = jsonTreeSchema;

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

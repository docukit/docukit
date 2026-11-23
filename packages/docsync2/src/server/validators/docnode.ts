import type { Json, JsonDoc, JsonTree, Operations } from "@docukit/docnode";
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

/** Each value as a JSON string, except a text value, stored as JSON. */
const treeStateSchema = v.record(
  v.string(),
  v.union([v.string(), v.array(jsonSchema)]),
);

/** `[id, type, state, children?]`: see `JsonTree` in `@docukit/docnode`. */
const jsonTreeSchema: v.GenericSchema<unknown, JsonTree> = v.lazy(() => {
  const childrenSchema = v.tupleWithRest([jsonTreeSchema], jsonTreeSchema);

  return v.union([
    v.tuple([v.string(), v.string(), treeStateSchema]),
    v.tuple([v.string(), v.string(), treeStateSchema, childrenSchema]),
  ]);
});

const headSchema = v.union([v.string(), v.array(v.string())]);
/** A node: a string, a number (its distance from the head's counter), or `0`. */
const nodeRefSchema = v.union([v.string(), v.pipe(v.number(), v.integer())]);
const letterRefSchema = v.union([v.string(), v.number()]);
const nodesSchema = v.array(v.tuple([nodeRefSchema, v.string()]));
const textSchema = v.union([v.string(), v.tuple([v.string()])]);
const editTagSchema = v.pipe(v.number(), v.maxValue(-1));

/** Each row of a batch (see `Operations` in `@docukit/docnode`). */
const rowSchema = v.union([
  v.tupleWithRest([v.literal(0), nodesSchema], nodeRefSchema),
  v.tupleWithRest([v.literal(0), nodeRefSchema, v.string()], nodeRefSchema),
  v.tupleWithRest([v.literal(1)], nodeRefSchema),
  v.tupleWithRest([v.literal(2), nodeRefSchema], nodeRefSchema),
  v.tupleWithRest([textSchema], letterRefSchema),
  v.tupleWithRest([editTagSchema], jsonSchema),
  v.string(),
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
  v.tupleWithRest([headSchema, v.string()], letterRefSchema),
  v.tupleWithRest([headSchema, editTagSchema], jsonSchema),
]);

/** See `JsonDoc` in `@docukit/docnode`. */
const storedRest = [
  v.optional(
    v.union([v.string(), v.array(jsonSchema), v.literal(0), v.literal(1)]),
  ),
  v.optional(v.union([v.string(), v.literal(0)])),
  v.optional(v.union([v.array(v.string()), v.literal(0)])),
  v.optional(v.union([v.array(jsonSchema), v.literal(0)])),
];
// The root's state is left out when it is empty.
const jsonDocShape = v.union([
  v.strictTuple([
    v.array(v.string()),
    v.string(),
    v.record(v.string(), jsonSchema),
    ...storedRest,
  ]),
  v.strictTuple([v.array(v.string()), v.string(), ...storedRest]),
]);
// Its elements at the end are left out, not undefined.
const jsonDocSchema = v.custom<JsonDoc>((input) => v.is(jsonDocShape, input));

/** What `Doc.fromJSON` reads. */
const serializedDocSchema = v.union([jsonDocSchema, jsonTreeSchema]);

export const DocNodeValidators = () => {
  return {
    serializedDoc(input: unknown): JsonDoc | JsonTree {
      return v.parse(serializedDocSchema, input);
    },
    operations(input: unknown): Operations {
      return v.parse(operationsSchema, input);
    },
  };
};

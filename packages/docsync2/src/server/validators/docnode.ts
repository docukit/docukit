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

/** A row that inserts, deletes or moves nodes (see `Operations` in `@docukit/docnode`). */
const orderedRowSchema = v.union([
  v.pipe(
    v.tupleWithRest([v.literal(0), insertedNodesSchema], nodeRefSchema),
    v.maxLength(5),
  ),
  // One node, without the list.
  v.pipe(
    v.tupleWithRest([v.literal(0), nodeRefSchema, v.string()], nodeRefSchema),
    v.maxLength(6),
  ),
  v.pipe(
    v.tupleWithRest([v.literal(1), nodeRefSchema], nodeRefSchema),
    v.maxLength(3),
  ),
  v.pipe(
    v.tupleWithRest([v.literal(2), nodeRefSchema], nodeRefSchema),
    v.maxLength(6),
  ),
]);

/** The state patch: `[-9, node, key, value, ...]`, the last row. Keys are strings. */
const patchRowSchema = v.pipe(
  v.tupleWithRest(
    [v.literal(-9)],
    v.lazy(() => jsonSchema),
  ),
  v.check(
    (row) =>
      row.length % 3 === 1 &&
      row.every((item, index) => index % 3 !== 2 || typeof item === "string"),
  ),
);

const rowsSchema = v.pipe(
  v.array(v.union([orderedRowSchema, patchRowSchema])),
  v.check((rows) =>
    rows.every((row, index) => row[0] !== -9 || index === rows.length - 1),
  ),
);

const headSchema = v.tupleWithRest([v.string()], v.unknown());

/**
 * `[head, ...rows]`, or `[head, ...row]` for one row that is not a state
 * patch. The batch is checked as it is and kept as it came, so that no
 * schema adds or drops an item.
 */
const operationsSchema = v.custom<Operations>(
  (input) =>
    v.is(headSchema, input) &&
    (typeof input[1] === "number"
      ? v.is(orderedRowSchema, input.slice(1))
      : v.is(rowsSchema, input.slice(1))),
);

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
const columns = [
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
] as const;
const serializedDocSchema: v.GenericSchema<unknown, JsonDoc> = v.union([
  v.strictTuple([v.string(), v.string(), stateSchema]),
  v.strictTuple(columns),
  // With the integer column.
  v.strictTuple([...columns, v.string()]),
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

import * as v from "valibot";
import type { NonNullableValue } from "../types.js";

export const docValueSchema = v.nonNullish(v.unknown());

export const getDocDataSchema = v.object({
  docId: v.string(),
  doc: v.union([docValueSchema, v.undefined_()]),
});

export const existingGetDocDataSchema = v.object({
  docId: v.string(),
  doc: docValueSchema,
});

export type GetDocData<D extends NonNullableValue = NonNullableValue> =
  v.InferOutput<typeof getDocDataSchema> & { doc: D | undefined };

export type ExistingGetDocData<D extends NonNullableValue = NonNullableValue> =
  v.InferOutput<typeof existingGetDocDataSchema> & { doc: D };

export const isGetDocData = (value: unknown): value is GetDocData => {
  return v.safeParse(getDocDataSchema, value).success;
};

export const isExistingGetDocData = <
  D extends NonNullableValue = NonNullableValue,
>(
  value: unknown,
  _docType?: { create(type: string, id: string): { doc: D } },
): value is ExistingGetDocData<D> => {
  return v.safeParse(existingGetDocDataSchema, value).success;
};

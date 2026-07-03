import * as v from "valibot";

export const docValueSchema = v.custom<object>(
  (value) => typeof value === "object" && value !== null,
);

export const getDocDataSchema = v.object({
  docId: v.string(),
  doc: v.union([docValueSchema, v.undefined_()]),
});

export const existingGetDocDataSchema = v.object({
  docId: v.string(),
  doc: docValueSchema,
});

export type GetDocData<D extends object = object> = {
  docId: string;
  doc: D | undefined;
};

export type ExistingGetDocData<D extends object = object> = {
  docId: string;
  doc: D;
};

export const isGetDocData = (value: unknown): value is GetDocData => {
  return v.safeParse(getDocDataSchema, value).success;
};

export const isExistingGetDocData = <D extends object = object>(
  value: unknown,
  _docType?: { create(type: string, id: string): { doc: D } },
): value is ExistingGetDocData<D> => {
  return v.safeParse(existingGetDocDataSchema, value).success;
};

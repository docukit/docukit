import * as v from "valibot";

export const getDocKeySchema = v.tuple([
  v.literal("docsync2"),
  v.literal("doc"),
  v.string(),
  v.string(),
]);

export type GetDocKey = v.InferOutput<typeof getDocKeySchema>;

export const isGetDocKey = (value: unknown): value is GetDocKey => {
  return v.safeParse(getDocKeySchema, value).success;
};

import * as v from "valibot";

export const presenceQueryKeySchema = v.tuple([
  v.literal("docsync2"),
  v.literal("presence"),
  v.string(),
]);

export type PresenceQueryKey = v.InferOutput<typeof presenceQueryKeySchema>;

export const isPresenceQueryKey = (
  value: unknown,
): value is PresenceQueryKey => {
  return v.safeParse(presenceQueryKeySchema, value).success;
};

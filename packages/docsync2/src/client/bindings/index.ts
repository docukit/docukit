import type { DocBinding } from "./types.js";

export const createDocBinding = <
  D extends object,
  S extends object,
  O extends object = object,
>(
  docBinding: DocBinding<D, S, O>,
): DocBinding<D, S, O> => {
  return docBinding;
};

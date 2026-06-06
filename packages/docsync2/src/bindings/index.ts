import type { DocBinding } from "../shared/types.js";

export const createDocBinding = <D extends object, S, O = unknown>(
  docBinding: DocBinding<D, S, O>,
): DocBinding<D, S, O> => {
  return docBinding;
};

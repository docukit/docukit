import type { DocBinding, NonNullableValue } from "../shared/types.js";

export const createDocBinding = <
  D extends NonNullableValue,
  S extends NonNullableValue,
  O extends NonNullableValue = NonNullableValue,
>(
  docBinding: DocBinding<D, S, O>,
): DocBinding<D, S, O> => {
  return docBinding;
};

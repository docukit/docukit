/* eslint-disable @typescript-eslint/no-empty-object-type */

import type { DocBinding } from "../shared/types.js";

export const createDocBinding = <D extends {}, S extends {}, O extends {} = {}>(
  docBinding: DocBinding<D, S, O>,
): DocBinding<D, S, O> => {
  return docBinding;
};

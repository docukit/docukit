import type { ClientProvider, DocBinding } from "@docukit/docsync2/client";

export const createTestProvider = <
  D extends object,
  S extends object,
  O extends object,
>(
  _docBinding: DocBinding<D, S, O>,
): ClientProvider<S, O> => ({
  transaction: (_mode, callback) =>
    callback({
      getSerializedDoc: () => Promise.resolve(undefined),
      getOperations: () => Promise.resolve([]),
      deleteOperations: () => Promise.resolve(),
      saveOperations: () => Promise.resolve(),
      saveSerializedDoc: () => Promise.resolve(),
    }),
});

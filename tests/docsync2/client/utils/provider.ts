import type {
  ClientProvider,
  DocBinding,
  NonNullableValue,
} from "@docukit/docsync2/client";

export const createTestProvider = <
  D extends NonNullableValue,
  S extends NonNullableValue,
  O extends NonNullableValue,
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

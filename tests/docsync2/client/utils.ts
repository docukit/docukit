import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { vi } from "vitest";
import {
  DocSync2Client,
  getDocKey,
  type DocBinding,
} from "@docukit/docsync2/client";

type TestDoc = { id: string; type: string };
type TestSerializedDoc = { id: string };
type TestOperation = { value: string };

export const testDocArgs = { type: "note", id: "doc-1" };

const createTestDocBinding = () => {
  const create = vi.fn((type: string, id: string) => ({
    doc: { id, type },
    docId: id,
  }));

  const binding: DocBinding<TestDoc, TestSerializedDoc, TestOperation> = {
    create,
    deserialize: (serializedDoc) => ({ id: serializedDoc.id, type: "note" }),
    serialize: (doc) => ({ id: doc.id }),
    onChange: () => undefined,
    applyOperations: () => undefined,
  };

  return { binding, create };
};

export const createTestClient = () => {
  const queryClient = new QueryClient();
  const { binding, create } = createTestDocBinding();
  const docSync = new DocSync2Client({ queryClient, docBinding: binding });

  return { queryClient, docSync, create };
};

export const createTestDoc = ({
  docSync,
}: ReturnType<typeof createTestClient>) =>
  docSync.mutations.createDoc(testDocArgs);

export const getTestDocKey = () => getDocKey(testDocArgs);

export const observeTestDoc = ({
  queryClient,
  docSync,
}: ReturnType<typeof createTestClient>) => {
  const observer = new QueryObserver(
    queryClient,
    docSync.queries.getDoc(testDocArgs),
  );
  const unsubscribe = observer.subscribe(() => undefined);

  return { observer, unsubscribe };
};

export const tick = (ms = 3) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

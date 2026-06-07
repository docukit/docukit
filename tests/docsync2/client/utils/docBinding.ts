import { vi } from "vitest";
import type { DocBinding } from "@docukit/docsync2/client";

export type TestDoc = { id: string; type: string };
export type TestSerializedDoc = { id: string };
export type TestOperation = { value: string };

export const createTestDocBinding = () => {
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

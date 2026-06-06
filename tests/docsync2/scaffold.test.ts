import { QueryClient } from "@tanstack/query-core";
import { describe, expect, test } from "vitest";
import {
  DocSync2Client,
  createDoc,
  docPresence,
  docQuery,
  indexedDBProvider,
  setDocPresence,
  type CreateDocArgs,
} from "@docukit/docsync2/client";
import { DocSync2Server } from "@docukit/docsync2/server";
import { DocNodeBinding } from "@docukit/docsync2/docnode";
import { createDocBinding, type DocBinding } from "@docukit/docsync2";

describe("@docukit/docsync2 scaffold", () => {
  test("exports the minimal package surface", () => {
    expect(DocSync2Client).toBeTypeOf("function");
    expect(DocSync2Server).toBeTypeOf("function");
    expect(DocNodeBinding).toBeTypeOf("function");
    expect(createDocBinding).toBeTypeOf("function");
    expect(indexedDBProvider).toBeTypeOf("function");
  });

  test("docQuery returns the expected doc query key", () => {
    expect(docQuery({ type: "note", id: "doc-1" }).queryKey).toStrictEqual([
      "docukit",
      "docsync2",
      "doc",
      "note",
      "doc-1",
    ]);
  });

  test("docQuery does not accept createIfMissing", () => {
    // @ts-expect-error -- docs are created through createDoc, not docQuery.
    docQuery({ type: "note", id: "doc-1", createIfMissing: true });

    expect(docQuery({ type: "note", id: "doc-1" }).queryKey).toStrictEqual([
      "docukit",
      "docsync2",
      "doc",
      "note",
      "doc-1",
    ]);
  });

  test("docPresence returns the expected presence query key", () => {
    expect(docPresence({ docId: "doc-1" }).queryKey).toStrictEqual([
      "docukit",
      "docsync2",
      "presence",
      "doc-1",
    ]);
  });

  test("createDoc requires a stable id in its args type", () => {
    const validCreateDocArgs = {
      type: "note",
      id: "doc-1",
    } satisfies CreateDocArgs;

    // @ts-expect-error -- createDoc must not accept missing document ids.
    const _missingCreateDocId = { type: "note" } satisfies CreateDocArgs;

    expect(validCreateDocArgs.id).toBe("doc-1");
  });

  test("DocSync2Client receives the TanStack query client in its constructor", () => {
    const queryClient = new QueryClient();
    const docSync = new DocSync2Client({ queryClient });

    expect(docSync.config.queryClient).toBe(queryClient);
  });

  test("docQuery returns undefined doc data before creation", async () => {
    const queryClient = new QueryClient();
    new DocSync2Client({ queryClient });

    await expect(
      queryClient.fetchQuery(docQuery({ type: "note", id: "doc-1" })),
    ).resolves.toStrictEqual({ docId: "doc-1", doc: undefined });
  });

  test("createDoc creates through the binding and seeds docQuery data", async () => {
    type TestDoc = { id: string; type: string };
    type TestSerializedDoc = { id: string };
    type TestOperation = { value: string };

    const queryClient = new QueryClient();
    const binding: DocBinding<TestDoc, TestSerializedDoc, TestOperation> = {
      create: (type, id) => ({ doc: { id, type }, docId: id }),
      deserialize: (serializedDoc) => ({ id: serializedDoc.id, type: "note" }),
      serialize: (doc) => ({ id: doc.id }),
      onChange: () => undefined,
      applyOperations: () => undefined,
      dispose: () => undefined,
    };
    new DocSync2Client({ queryClient, docBinding: binding });

    await expect(
      createDoc(queryClient, { type: "note", id: "doc-1" }),
    ).resolves.toStrictEqual({
      docId: "doc-1",
      doc: { id: "doc-1", type: "note" },
    });

    await expect(
      queryClient.fetchQuery(docQuery({ type: "note", id: "doc-1" })),
    ).resolves.toStrictEqual({
      docId: "doc-1",
      doc: { id: "doc-1", type: "note" },
    });
  });

  test("unfinished client methods throw the placeholder error", () => {
    const docSync = new DocSync2Client({ queryClient: new QueryClient() });

    expect(() => docSync.connect()).toThrow("not implemented yet");
    expect(() => docSync.disconnect()).toThrow("not implemented yet");
  });

  test("unfinished server methods throw the placeholder error", async () => {
    const server = new DocSync2Server();

    expect(() => server.start()).toThrow("not implemented yet");
    await expect(server.close()).rejects.toThrow("not implemented yet");
  });

  test("createDoc requires a registered DocSync2Client", async () => {
    const queryClient = new QueryClient();

    await expect(
      createDoc(queryClient, { type: "note", id: "doc-1" }),
    ).rejects.toThrow("DocSync2Client is not registered for this QueryClient");
  });

  test("createDoc requires a docBinding", async () => {
    const queryClient = new QueryClient();
    new DocSync2Client({ queryClient });

    await expect(
      createDoc(queryClient, { type: "note", id: "doc-1" }),
    ).rejects.toThrow("DocSync2Client requires docBinding to create docs");
  });

  test("unfinished presence mutation and provider functions reject with the placeholder error", async () => {
    const queryClient = new QueryClient();

    await expect(docPresence({ docId: "doc-1" }).queryFn()).rejects.toThrow(
      "not implemented yet",
    );
    await expect(
      setDocPresence(queryClient, { docId: "doc-1", presence: {} }),
    ).rejects.toThrow("not implemented yet");
    expect(() => indexedDBProvider({ userId: "user-1" })).toThrow(
      "not implemented yet",
    );
  });

  test("createDocBinding returns the provided binding", () => {
    type TestDoc = { id: string };
    type TestSerializedDoc = { id: string };
    type TestOperation = { value: string };

    const binding: DocBinding<TestDoc, TestSerializedDoc, TestOperation> = {
      create: (_type, id) => ({ doc: { id }, docId: id }),
      deserialize: (serializedDoc) => ({ id: serializedDoc.id }),
      serialize: (doc) => ({ id: doc.id }),
      onChange: () => undefined,
      applyOperations: () => undefined,
      dispose: () => undefined,
    };

    expect(createDocBinding(binding)).toBe(binding);
  });
});

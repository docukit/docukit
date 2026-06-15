import { describe, expect, test } from "vitest";
import { isExistingGetDocData } from "@docukit/docsync2/client";
import { createTestClient } from "../../utils/client.js";
import {
  disconnectTestClient,
  reconnectTestClient,
} from "../../utils/connection.js";
import { createTestDoc } from "../../utils/doc.js";

describe("createDoc", () => {
  test("returns the doc id and seeds getDoc", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync, docBinding } = testClient;

    const result = await docSync.mutations.createDoc(testClient.docArgs);
    const created = queryClient.getQueryData(
      docSync.queries.getDoc(testClient.docArgs).queryKey,
    );
    const queried = await queryClient.fetchQuery(
      docSync.queries.getDoc(testClient.docArgs),
    );

    expect(result).toStrictEqual({ docId: testClient.docArgs.id });
    expect(isExistingGetDocData(created, docBinding)).toBe(true);
    if (!isExistingGetDocData(created, docBinding)) return;
    expect(isExistingGetDocData(queried, docBinding)).toBe(true);
    if (!isExistingGetDocData(queried, docBinding)) return;
    expect(queried.doc).toBe(created.doc);
    expect(queried).toStrictEqual(created);
  });

  test("calling createDoc twice for the same id keeps the existing getDoc doc", async () => {
    const testClient = createTestClient();
    const { docSync } = testClient;

    const first = await createTestDoc(testClient);
    const result = await docSync.mutations.createDoc(testClient.docArgs);
    const second = await createTestDoc(testClient);

    expect(result).toStrictEqual({ docId: testClient.docArgs.id });
    expect(second.doc).toBe(first.doc);
    expect(second).toStrictEqual(first);
  });

  test("persists the created doc so getDoc can load it from the local provider", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync, docBinding, docArgs } = testClient;

    const created = await createTestDoc(testClient);
    queryClient.clear();

    const queried = await queryClient.fetchQuery(
      docSync.queries.getDoc(docArgs),
    );

    expect(isExistingGetDocData(queried, docBinding)).toBe(true);
    if (!isExistingGetDocData(queried, docBinding)) return;
    expect(queried.doc).not.toBe(created.doc);
    expect(queried.doc.toJSON()).toStrictEqual(created.doc.toJSON());
  });

  test("disconnected client creates a local doc and seeds getDoc", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync, docBinding, docArgs } = testClient;
    await reconnectTestClient(testClient);
    await disconnectTestClient(testClient);

    const result = await docSync.mutations.createDoc(docArgs);
    const created = queryClient.getQueryData(
      docSync.queries.getDoc(docArgs).queryKey,
    );

    expect(result).toStrictEqual({ docId: docArgs.id });
    expect(isExistingGetDocData(created, docBinding)).toBe(true);
  });
});

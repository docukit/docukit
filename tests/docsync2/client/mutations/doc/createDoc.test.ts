import { describe, expect, test } from "vitest";
import { createTestClient, createTestDoc } from "../../utils/index.js";

describe("createDoc", () => {
  test("creates one in-memory doc and seeds getDoc", async () => {
    const testClient = createTestClient();
    const { queryClient, docSync } = testClient;

    const created = await createTestDoc(testClient);
    const queried = await queryClient.fetchQuery(
      docSync.queries.getDoc(testClient.docArgs),
    );

    expect(queried.doc).toBe(created.doc);
    expect(queried).toStrictEqual(created);
  });

  test("calling createDoc twice for the same id returns the existing doc", async () => {
    const testClient = createTestClient();

    const first = await createTestDoc(testClient);
    const second = await createTestDoc(testClient);

    expect(second.doc).toBe(first.doc);
    expect(second).toStrictEqual(first);
  });
});

import { describe, expect, test } from "vitest";
import { reconnectTestClient } from "../client/utils/connection.js";
import { createTestDocArgs } from "../client/utils/generators.js";
import {
  appendTestNode,
  expectParallelFetching,
  expectPeerToConverge,
  testWrapper,
} from "./utils.js";

describe("DocSync2 integration sync", () => {
  test("getDoc syncs for different docs can fetch in parallel", async () => {
    await testWrapper(async ({ reference }) => {
      const doc1Args = reference.docArgs;
      const doc2Args = createTestDocArgs();
      await reference.createMissingDoc(doc1Args);
      await reference.createMissingDoc(doc2Args);
      reference.queryClient.clear();

      const observed1 = reference.observeDoc(doc1Args);
      const observed2 = reference.observeDoc(doc2Args);

      await expectParallelFetching(observed1, observed2);
    });
  });

  test("created docs sync their initial serialized doc before local edits", async () => {
    await testWrapper(async ({ reference }) => {
      const created = await reference.createMissingDoc();
      await reconnectTestClient(reference);
      reference.observeDoc();
      const syncs = reference.recordSyncs();

      reference.invalidateDoc();

      await expect
        .poll(() => syncs[0])
        .toStrictEqual({
          sentDoc: true,
          sentOperations: 0,
          receivedDoc: false,
        });
      await expectPeerToConverge(reference, created.doc);
    });
  });

  test("once the server has the doc, syncs carry only operations", async () => {
    await testWrapper(
      async ({ reference }) => {
        const { doc } = await reference.createMissingDoc();
        const observed = reference.observeDoc();
        await reference.editAndSync(observed);
        const syncs = reference.recordSyncs();

        await reference.editAndSync(observed);
        await reference.editAndSync(observed);

        expect(syncs).toStrictEqual([
          { sentDoc: false, sentOperations: 1, receivedDoc: false },
          { sentDoc: false, sentOperations: 1, receivedDoc: false },
        ]);
        await expectPeerToConverge(reference, doc);
      },
      { timing: { singleClientMaxDebounce: 0 } },
    );
  });

  test("a doc created offline reaches the server with its edits and converges", async () => {
    await testWrapper(
      async ({ reference }) => {
        const { observed, doc } = await reference.createDocOffline();
        appendTestNode(doc);
        const syncs = reference.recordSyncs();

        reference.docSync.connect();
        await expect
          .poll(() => syncs[0])
          .toStrictEqual({
            sentDoc: true,
            sentOperations: 1,
            receivedDoc: false,
          });
        await reference.editAndSync(observed);

        expect(syncs.at(-1)).toStrictEqual({
          sentDoc: false,
          sentOperations: 1,
          receivedDoc: false,
        });
        await expectPeerToConverge(reference, doc);
      },
      { timing: { singleClientMaxDebounce: 0 } },
    );
  });
});

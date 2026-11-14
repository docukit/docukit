import { describe, expect, test } from "vitest";
import { commitEdits, testWrapper } from "./utils.js";

const onlyOperations = { sentDoc: false, receivedDoc: false };

describe("Sync payloads", () => {
  test("once the server has the doc, syncs carry only operations", async () => {
    await testWrapper(async ({ reference, addNewDevice }) => {
      await reference.loadDoc();
      commitEdits(reference, ["first"]);
      await reference.assertIDBDoc({ doc: ["first"], ops: [] });
      const syncs = reference.recordSyncs();

      commitEdits(reference, ["second", "third"]);
      await reference.assertIDBDoc({
        doc: ["first", "second", "third"],
        ops: [],
      });

      expect(syncs).not.toHaveLength(0);
      expect(syncs).toStrictEqual(syncs.map(() => onlyOperations));
      const newDevice = await addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc(["first", "second", "third"]);
    });
  });

  test("a doc created offline reaches the server with its edits and converges", async () => {
    await testWrapper(async ({ reference, addNewDevice }) => {
      reference.disconnect();
      await reference.loadDoc();
      commitEdits(reference, ["offline"]);
      await reference.assertIDBDoc({ doc: [], ops: ["offline"] });
      const syncs = reference.recordSyncs();

      reference.connect();
      await reference.assertIDBDoc({ doc: ["offline"], ops: [] });
      commitEdits(reference, ["online"]);
      await reference.assertIDBDoc({ doc: ["offline", "online"], ops: [] });

      const [firstSync, ...laterSyncs] = syncs;
      expect(firstSync).toStrictEqual({ sentDoc: true, receivedDoc: false });
      expect(laterSyncs).not.toHaveLength(0);
      expect(laterSyncs).toStrictEqual(laterSyncs.map(() => onlyOperations));
      const newDevice = await addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc(["offline", "online"]);
    });
  });
});

import { describe, expect, test } from "vitest";
import { commitEdits, testWrapper } from "./utils.js";

/** The server consolidates when a client is missing this many operations. */
const THRESHOLD = 100;

const edits = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`);

type Clients = Parameters<Parameters<typeof testWrapper>[0]>[0];

/**
 * Both devices have a local copy of "first". The returning device then goes
 * offline, so everything the writer commits from here on is missing from it.
 */
const setupReturningDevice = async ({ reference, otherDevice }: Clients) => {
  await reference.loadDoc();
  commitEdits(reference, ["first"]);
  await otherDevice.loadDoc();
  await otherDevice.assertIDBDoc({ doc: ["first"], ops: [] });
  otherDevice.disconnect();
  return { writer: reference, returning: otherDevice };
};

const commitAndUpload = async (
  writer: Clients["reference"],
  texts: string[],
  expectedDoc: string[],
) => {
  commitEdits(writer, texts);
  await writer.assertIDBDoc({ doc: expectedDoc, ops: [] });
};

describe("Server consolidation", () => {
  test("keeps the document when a returning device triggers it", async () => {
    await testWrapper(async (clients) => {
      const { writer, returning } = await setupReturningDevice(clients);
      const expected = ["first", ...edits("edit", THRESHOLD)];
      await commitAndUpload(writer, edits("edit", THRESHOLD), expected);

      returning.connect();
      await returning.assertMemoryDoc(expected);

      const newDevice = await clients.addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc(expected);
    });
  });

  test("keeps the text of a writer who stays online while a device returns with offline edits", async () => {
    await testWrapper(async (clients) => {
      const { writer, returning } = await setupReturningDevice(clients);
      commitEdits(returning, ["offline"]);
      const expected = ["first", "offline", ...edits("edit", THRESHOLD)];
      await commitAndUpload(writer, edits("edit", THRESHOLD), [
        "first",
        ...edits("edit", THRESHOLD),
      ]);

      returning.connect();
      await returning.assertMemoryDoc(expected);
      await writer.assertMemoryDoc(expected);

      // The writer's next sync picks up the snapshot this consolidation saved.
      commitEdits(writer, ["after"]);
      await returning.assertMemoryDoc([...expected, "after"]);
      await writer.assertMemoryDoc([...expected, "after"]);

      const newDevice = await clients.addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc([...expected, "after"]);
    });
  });

  test("applies each operation once across consecutive consolidations", async () => {
    await testWrapper(async (clients) => {
      const { writer, returning } = await setupReturningDevice(clients);
      const firstRound = ["first", ...edits("round 1", THRESHOLD)];
      await commitAndUpload(writer, edits("round 1", THRESHOLD), firstRound);
      returning.connect();
      await returning.assertMemoryDoc(firstRound);

      returning.disconnect();
      const secondRound = [...firstRound, ...edits("round 2", THRESHOLD)];
      await commitAndUpload(writer, edits("round 2", THRESHOLD), secondRound);
      returning.connect();
      await returning.assertMemoryDoc(secondRound);

      const newDevice = await clients.addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc(secondRound);
    });
  });

  test("reports the snapshot clock once the operation log has been trimmed", async () => {
    await testWrapper(async (clients) => {
      const { writer, returning } = await setupReturningDevice(clients);
      const expected = ["first", ...edits("edit", THRESHOLD)];
      await commitAndUpload(writer, edits("edit", THRESHOLD), expected);
      returning.connect();
      await returning.assertMemoryDoc(expected);

      const newDevice = await clients.addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc(expected);
      await expect
        .poll(() => newDevice.storedClock())
        .toBe(await returning.storedClock());
    });
  });

  test("does not consolidate a returning device below the threshold", async () => {
    await testWrapper(async (clients) => {
      const { writer, returning } = await setupReturningDevice(clients);
      const belowThreshold = edits("edit", THRESHOLD - 1);
      const expected = ["first", ...belowThreshold];
      await commitAndUpload(writer, belowThreshold, expected);

      returning.connect();
      await returning.assertMemoryDoc(expected);

      const newDevice = await clients.addNewDevice();
      await newDevice.loadDoc({ createIfMissing: false });
      await newDevice.assertMemoryDoc(expected);
    });
  });

  test.each([true, false])(
    "keeps the document when a device with no local copy triggers it (createIfMissing: %s)",
    async (createIfMissing) => {
      await testWrapper(async ({ reference: writer, addNewDevice }) => {
        await writer.loadDoc();
        const expected = edits("edit", THRESHOLD);
        await commitAndUpload(writer, expected, expected);

        const firstReader = await addNewDevice();
        await firstReader.loadDoc({ createIfMissing });
        await firstReader.assertMemoryDoc(expected);

        const secondReader = await addNewDevice();
        await secondReader.loadDoc({ createIfMissing: false });
        await secondReader.assertMemoryDoc(expected);
      });
    },
  );
});

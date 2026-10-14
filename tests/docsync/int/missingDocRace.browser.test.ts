import { expect, test } from "vitest";
import type { JsonDoc, Operations } from "@docukit/docnode";
import type { SyncEvent } from "@docukit/docsync/client";
import {
  afterInitialLocalRead,
  holdNextLocalWrite,
  testWrapper,
  waitForLocalBroadcast,
} from "./utils.js";

test.each(["before rerun", "after rerun"] as const)(
  "recovers a discarded broadcast when the edit is persisted %s",
  async (persistWhen) => {
    await testWrapper(async ({ docId, reference, otherTab, otherDevice }) => {
      await otherDevice.loadDoc();
      otherDevice.addChild("Remote");
      otherDevice.doc?.forceCommit();
      await otherDevice.assertIDBDoc({ doc: ["Remote"], ops: [] });
      await reference.assertIDBDoc();

      const exchanges: SyncEvent<Operations, JsonDoc>[] = [];
      const stopRecording = reference.client.on("sync", (event) => {
        if (event.req.docId === docId) exchanges.push(event);
      });
      let pendingOperations: Operations[] = [];
      let pendingWrite: Promise<boolean> | undefined;
      let heldWrite: Awaited<ReturnType<typeof holdNextLocalWrite>> | undefined;
      const restoreRead = await afterInitialLocalRead(
        reference,
        async () => {
          await otherTab.loadDoc();
          await otherTab.assertIDBDoc({ doc: ["Remote"], ops: [] });
          // Only reference can upload Pending: its author is offline.
          otherTab.disconnect();
        },
        async () => {
          if (persistWhen === "after rerun") {
            heldWrite = await holdNextLocalWrite(otherTab);
          }
          otherTab.addChild("Pending");
          otherTab.doc?.forceCommit();
          pendingOperations =
            otherTab.client["_localOpsBatchState"].get(docId)?.data ?? [];
          expect(pendingOperations).toHaveLength(1);
          pendingWrite = otherTab.client["_flushLocalOperations"](docId, {
            sync: false,
          });
          if (heldWrite) {
            await heldWrite.captured;
          } else {
            await pendingWrite;
          }
          await waitForLocalBroadcast();
          expect(reference.client["_syncQueue"].get(docId)?.rerun).toBe(true);
          expect(
            await reference.client["_docsCache"].get(docId)?.promisedDoc,
          ).toBeUndefined();
          await otherTab.assertIDBDoc({
            doc: ["Remote"],
            ops: heldWrite ? [] : ["Pending"],
          });
        },
      );
      const observer = reference.client.getDocObserver({
        id: docId,
        type: "test",
        createIfMissing: false,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      try {
        await expect
          .poll(() => observer.getSnapshot().fetchStatus)
          .toBe("idle");
        await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
        expect(exchanges).toHaveLength(2);
        expect(exchanges[0]?.req.operations).toStrictEqual([]);
        expect(exchanges[1]?.req.operations).toStrictEqual(
          heldWrite ? [] : pendingOperations,
        );

        if (heldWrite) {
          // Both sync reads ran before the write, so neither request carried
          // Pending. Complete the real write; only now is a reread sufficient.
          await reference.assertIDBDoc({ doc: ["Remote"], ops: [] });
          heldWrite.release();
          await pendingWrite;
          await reference.assertIDBDoc({ doc: ["Remote"], ops: ["Pending"] });
          // A later sync proves the reconciliation bug independently of a
          // future decision about how to signal completion of another tab's write.
          await reference.client["_sync"](docId);
          await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
        }

        const uploads = exchanges.filter(
          (exchange) => exchange.req.operations.length > 0,
        );
        expect(uploads).toHaveLength(1);
        expect(uploads[0]?.req.operations).toStrictEqual(pendingOperations);
        for (const exchange of exchanges) {
          expect(exchange.error).toBeUndefined();
          expect(exchange.req.docId).toBe(docId);
          expect(exchange.req.serializedDoc).not.toBeNull();
          expect(exchange.data?.serializedDoc).toBeNull();
          // The server acknowledges our pushed edit but does not echo it back.
          expect(exchange.data?.operations).toStrictEqual([]);
        }
        const upload = uploads[0];
        expect(upload?.data?.clock).toBeGreaterThan(upload?.req.clock ?? 0);
        await reference.assertIDBDoc({ doc: ["Remote", "Pending"], ops: [] });
        expect(
          otherTab.reqSpy.mock.calls.filter(
            ([event, payload]) =>
              event === "sync" &&
              payload.operations instanceof Array &&
              payload.operations.length > 0,
          ),
        ).toHaveLength(0);

        // All protocol and durable-storage assertions above pass before this
        // regression assertion: the live document still lacks Pending.
        const result = observer.getSnapshot();
        expect(result.status).toBe("success");
        if (!result.data || !otherTab.doc)
          throw new Error("Document not loaded");
        const binding = reference.client["_docBinding"];
        expect(binding.serialize(result.data.doc)).toStrictEqual(
          binding.serialize(otherTab.doc),
        );
      } finally {
        heldWrite?.release();
        await pendingWrite;
        heldWrite?.restore();
        unsubscribe();
        stopRecording();
        restoreRead();
      }
    });
  },
);

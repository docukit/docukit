import type { DocSyncClient } from "../../index.js";

export async function loadOrCreateDoc<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  type?: string,
): Promise<D | "deleted" | undefined> {
  const local = await client["_localPromise"];
  if (!local) return undefined;

  return local.provider.transaction("readwrite", async (ctx) => {
    // Try to load existing doc
    const stored = await ctx.getSerializedDoc(docId);
    const localOperations = await ctx.getOperations({ docId });

    if (localOperations === "deleted") return "deleted";
    if (stored?.serializedDoc === "deleted") return "deleted";

    if (stored) {
      const doc = client["_docBinding"].deserialize(stored.serializedDoc);
      client["_shouldBroadcast"] = false;
      localOperations.forEach((operationsBatch) => {
        operationsBatch.forEach((operations) => {
          client["_docBinding"].applyOperations(doc, operations);
        });
      });
      client["_shouldBroadcast"] = true;
      return doc;
    }

    // Create new doc if type provided
    if (type) {
      const { doc } = client["_docBinding"].create(type, docId);
      client["_shouldBroadcast"] = false;
      if (localOperations.length > 0)
        throw new Error(
          `Doc ${docId} has operations stored locally but no serialized doc found`,
        );
      client["_shouldBroadcast"] = true;
      // Save the new doc to IDB
      await ctx.saveSerializedDoc({
        serializedDoc: client["_docBinding"].serialize(doc),
        docId,
        clock: 0,
      });
      return doc;
    }

    return undefined;
  });
}

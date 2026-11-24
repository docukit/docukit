import type { Doc } from "./main.js";
import { onApplyOperations, type Operations } from "./operations.js";

/**
 * Base: puts batches a server ordered before this replica's own ones, as
 * DocSync does, without loading the document again.
 *
 * - `rebase(doc)`: `doc` is the server's document. From then on it keeps
 *   what undoes, exactly, each of its transactions.
 * - `rebase(doc, confirmed)`: undoes them all, as one transaction, applies
 *   `confirmed` (the server's batches, in its order) as the server did, and
 *   keeps what undoes the next ones, such as its pending batches applied
 *   again. None of it goes to the undo history. False, and nothing changes,
 *   when `doc` keeps none: it has to be loaded again.
 *
 * A document with a CRDT engine does not need it: it never keeps them.
 */
export function rebase(doc: Doc, confirmed?: Operations[]): boolean {
  const journal = doc["_journal"];
  if (confirmed) {
    if (!journal) return false;
    doc.forceCommit(
      () => {
        doc["_journal"] = undefined;
        const key = doc["_editStateKey"];
        // The text undoes itself with what it left in the journal.
        doc["_editStateKey"] = undefined;
        for (let index = journal.length; index--; ) {
          const entry = journal[index]!;
          if (typeof entry === "function") entry();
          else onApplyOperations(doc, entry);
        }
        doc["_editStateKey"] = key;
      },
      { skipUndo: true },
    );
    // One transaction each: a batch that fails part of the way leaves the
    // others as they are, as on the server.
    for (const batch of confirmed)
      doc.applyOperations(batch, { skipUndo: true });
  }
  doc.forceCommit();
  if (!doc["_crdt"]) doc["_journal"] = [];
  return true;
}

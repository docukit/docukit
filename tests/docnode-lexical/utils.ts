import { Doc } from "@docukit/docnode";
import { createLexicalDocNodeConfig } from "@docukit/docnode-lexical";

export const createLexicalDoc = ({
  enableUndoManager = true,
  mergeInterval = 0,
}: { enableUndoManager?: boolean; mergeInterval?: number } = {}): Doc => {
  const doc = Doc.fromJSON(
    createLexicalDocNodeConfig({
      type: "root",
      undoManager: { maxUndoSteps: enableUndoManager ? 100 : 0, mergeInterval },
    }),
    ["01kc52hq510g6y44jhq0wqrjb3", "root", {}],
  );
  doc.forceCommit();
  return doc;
};

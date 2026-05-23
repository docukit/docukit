import { Doc } from "@docukit/docnode";
import { LexicalDocNode } from "@docukit/docnode-lexical";

export const createLexicalDoc = (): Doc => {
  return Doc.fromJSON(
    {
      type: "root",
      extensions: [{ nodes: [LexicalDocNode] }],
      undoManager: { maxUndoSteps: 100 },
    },
    ["01kc52hq510g6y44jhq0wqrjb3", "root", {}],
  );
};

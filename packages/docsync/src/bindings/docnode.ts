import { Doc, type DocConfig, type Operations } from "@docukit/docnode";
import { createDocBinding } from "./index.js";

export const DocNodeBinding = (docConfigs: DocConfig[]) => {
  const docConfigsMap = new Map<string, DocConfig>();

  docConfigs.forEach((docConfig) => {
    const type = docConfig.type ?? "";
    if (docConfigsMap.has(type)) {
      throw new Error(`Duplicate doc type: ${type}`);
    }
    docConfigsMap.set(type, docConfig);
  });

  return createDocBinding({
    create: (type, id) => {
      const docConfig = docConfigsMap.get(type);
      if (!docConfig) throw new Error(`Unknown type: ${type}`);
      const doc = new Doc({ ...docConfig, id });
      return { doc, docId: doc.root.id };
    },
    serialize: (doc) => doc.toJSON({ unsafe: true }),
    deserialize: (serializedDoc) => {
      const type = serializedDoc[1];
      const docConfig = docConfigsMap.get(type);
      if (!docConfig) throw new Error(`Unknown type: ${type}`);
      const doc = Doc.fromJSON(docConfig, serializedDoc);
      doc.forceCommit();
      return doc;
    },
    onChange: (doc, cb: (ev: { operations: Operations }) => void) =>
      doc.onChange(cb),
    applyOperations: (doc, operations) => {
      doc.applyOperations(operations);
      doc.forceCommit();
    },
    dispose: (doc) => doc.dispose(),
  });
};

/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Doc, type DocConfig, type Operations } from "docnode";

// TO-DECIDE: should params in fn's be objects?
export interface DocBinding<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  // method syntax is required to avoid type errors
  "new"(type: string, id?: string): { doc: D; id: string };
  deserialize(serializedDoc: S): D;
  serialize(doc: D): S;
  onChange(doc: D, cb: (ev: { operations: O }) => void): void;
  applyOperations(doc: D, operations: O): void;
  removeListeners(doc: D): void;
}

export const createDocBinding = <D extends {}, S extends {}, O extends {} = {}>(
  docBinding: DocBinding<D, S, O>,
): DocBinding<D, S, O> => {
  return docBinding;
};

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
    new: (type, id) => {
      const docConfig = docConfigsMap.get(type);
      if (!docConfig) throw new Error(`Unknown type: ${type}`);
      const doc = new Doc({ ...docConfig, id });
      return { doc, id: doc.root.id };
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
    removeListeners: (doc) => {
      // TODO: maybe doc should have a removeListeners method?
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_changeListeners"].clear();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_normalizeListeners"].clear();
    },
  });
};

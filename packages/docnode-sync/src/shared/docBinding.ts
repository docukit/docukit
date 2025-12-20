import { Doc, type DocConfig, type Operations } from "docnode";

// TO-DECIDE: should params in fn's be objects?
export interface DocBinding<D = NN, S = NN, O = NN> {
  new: (type: string, id?: string) => { doc: D; id: string };
  deserialize: (serializedDoc: S) => D;
  serialize: (doc: D) => S;
  onChange: (doc: D, cb: (ev: { operations: O }) => void) => void;
  applyOperations: (doc: D, operations: O) => void;
  removeListeners: (doc: D) => void;
}

export type NN = NonNullable<unknown>;

export const createDocBinding = <D, S, O>(
  docBinding: DocBinding<D, S, O>,
): DocBinding<D, S, O> => {
  return docBinding;
};

export const DocNodeBinding = (docConfigs: DocConfig[]) => {
  const docConfigsMap = new Map<string, DocConfig>();

  docConfigs.forEach((docConfig) => {
    const namespace = docConfig.namespace ?? "";
    if (docConfigsMap.has(namespace)) {
      throw new Error(`Duplicate namespace: ${namespace}`);
    }
    docConfigsMap.set(namespace, docConfig);
  });

  return createDocBinding({
    new: (type, id) => {
      const docConfig = docConfigsMap.get(type);
      if (!docConfig) throw new Error(`Unknown namespace: ${type}`);
      const doc = new Doc({ ...docConfig, id });
      return { doc, id: doc.root.id };
    },
    serialize: (doc) => doc.toJSON(),
    deserialize: (serializedDoc) => {
      const namespace = JSON.parse(serializedDoc[2].namespace!) as string;
      const docConfig = docConfigsMap.get(namespace);
      if (!docConfig) throw new Error(`Unknown namespace: ${namespace}`);
      const doc = Doc.fromJSON(docConfig, serializedDoc);
      doc.forceCommit();
      return doc;
    },
    onChange: (doc, cb: (ev: { operations: Operations }) => void) =>
      doc.onChange(cb),
    applyOperations: (doc, operations) => doc.applyOperations(operations),
    removeListeners: (doc) => {
      // TODO: maybe doc should have a removeListeners method?
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_changeListeners"].clear();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_normalizeListeners"].clear();
    },
  });
};

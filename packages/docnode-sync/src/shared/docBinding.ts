import { Doc, type DocConfig } from "docnode";

// TO-DECIDE: should params in fn's be objects?
export interface DocBinding<D = NN, S = NN, O = NN> {
  new: (type: string) => D;
  deserialize: (serializedDoc: S) => D;
  serialize: (doc: D) => S;
  onChange: (doc: D) => (cb: (ev: { operations: O }) => void) => () => void;
  applyOperations: (doc: D, operations: O) => void;
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
    new: (type) => {
      const docConfig = docConfigsMap.get(type);
      if (!docConfig) throw new Error(`Unknown namespace: ${type}`);
      return new Doc(docConfig);
    },
    serialize: (doc) => doc.toJSON(),
    deserialize: (serializedDoc) => {
      const namespace = JSON.parse(serializedDoc[2].namespace!) as string;
      const docConfig = docConfigsMap.get(namespace);
      if (!docConfig) throw new Error(`Unknown namespace: ${namespace}`);
      const doc = new Doc(docConfig);
      return doc;
    },
    onChange: (doc) => doc.onChange.bind(doc),
    applyOperations: (doc, operations) => doc.applyOperations(operations),
  });
};

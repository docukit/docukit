import * as Y from "yjs";
import { createDocBinding } from "./index.js";

// Socket.IO delivers binary data as ArrayBuffer in the browser,
// but Yjs requires Uint8Array. This helper normalizes at the boundary.
const toUint8Array = (data: Uint8Array): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if ((data as unknown) instanceof ArrayBuffer) {
    return new Uint8Array(data as unknown as ArrayBuffer);
  }
  return new Uint8Array(data);
};

type YjsDocTemplate = { type: string; initialize?: (doc: Y.Doc) => void };

export const YjsBinding = (templates?: YjsDocTemplate[]) => {
  const templateMap = new Map<string, YjsDocTemplate>();

  if (templates) {
    for (const template of templates) {
      if (templateMap.has(template.type)) {
        throw new Error(`Duplicate doc type: ${template.type}`);
      }
      templateMap.set(template.type, template);
    }
  }

  return createDocBinding<Y.Doc, Uint8Array, Uint8Array>({
    create: (type, id) => {
      const doc = id ? new Y.Doc({ guid: id }) : new Y.Doc();
      const template = templateMap.get(type);
      template?.initialize?.(doc);
      return { doc, docId: doc.guid };
    },
    serialize: (doc) => Y.encodeStateAsUpdate(doc),
    deserialize: (serializedDoc) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, toUint8Array(serializedDoc));
      return doc;
    },
    onChange: (doc, cb) => {
      const handler = (update: Uint8Array, origin: unknown) => {
        if (origin === "docsync-remote") return;
        cb({ operations: update });
      };
      doc.on("update", handler);
    },
    applyOperations: (doc, operations) => {
      Y.applyUpdate(doc, toUint8Array(operations), "docsync-remote");
    },
    dispose: (doc) => {
      doc.destroy();
    },
  });
};

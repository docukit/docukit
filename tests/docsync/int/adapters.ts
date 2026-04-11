import { DocNodeBinding } from "@docukit/docsync/docnode";
import { YjsBinding } from "@docukit/docsync/yjs";
import {
  defineNode,
  string,
  type Doc,
  type DocNode,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import * as Y from "yjs";
import type { DocBinding } from "@docukit/docsync/client";

// ============================================================================
// Adapter Type
// ============================================================================

export type TestAdapter<
  D extends object,
  S extends object,
  O extends object,
> = {
  name: string;
  serverUrl: string;
  createDocBinding: () => DocBinding<D, S, O>;
  addChild: (doc: D, text: string) => void;
  getChildren: (doc: D) => string[];
  getDocChildren: (binding: DocBinding<D, S, O>, serializedDoc: S) => string[];
  getOpsChildren: (ops: O[][]) => string[];
  forceCommit?: (doc: D) => void;
};

// ============================================================================
// DocNode Adapter
// ============================================================================

const ChildNode = defineNode({ type: "child", state: { value: string("") } });

export const testDocConfig = {
  type: "test",
  extensions: [{ nodes: [ChildNode] }],
};

export const docNodeAdapter: TestAdapter<Doc, JsonDoc, Operations> = {
  name: "DocNode",
  serverUrl: "ws://localhost:8082",
  createDocBinding: () => DocNodeBinding([testDocConfig]),
  addChild: (doc, text) => {
    const child = doc.createNode(ChildNode);
    child.state.value.set(text);
    doc.root.append(child);
  },
  getChildren: (doc) => {
    const children: string[] = [];
    doc.root.children().forEach((child) => {
      const typedChild = child as unknown as DocNode<typeof ChildNode>;
      children.push(typedChild.state.value.get());
    });
    return children;
  },
  getDocChildren: (binding, serializedDoc) => {
    const doc = binding.deserialize(serializedDoc);
    const children: string[] = [];
    doc.root.children().forEach((child) => {
      const typedChild = child as unknown as DocNode<typeof ChildNode>;
      children.push(typedChild.state.value.get());
    });
    return children;
  },
  getOpsChildren: (ops) => {
    const children: string[] = [];
    for (const batch of ops) {
      if (batch.length === 0) continue;
      for (const item of batch) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const stateUpdates = item[1];
        if (!stateUpdates || typeof stateUpdates !== "object") continue;
        for (const [, nodeState] of Object.entries(
          stateUpdates as Record<string, unknown>,
        )) {
          if (
            nodeState &&
            typeof nodeState === "object" &&
            "value" in nodeState
          ) {
            const jsonValue = (nodeState as { value: string }).value;
            children.push(JSON.parse(jsonValue) as string);
          }
        }
      }
    }
    return children;
  },
  forceCommit: (doc) => {
    doc.forceCommit();
  },
};

// ============================================================================
// Yjs Adapter
// ============================================================================

// Binary data may arrive as ArrayBuffer from Socket.IO or IDB
const toUint8Array = (data: Uint8Array): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if ((data as unknown) instanceof ArrayBuffer) {
    return new Uint8Array(data as unknown as ArrayBuffer);
  }
  return new Uint8Array(data);
};

export const yjsAdapter: TestAdapter<Y.Doc, Uint8Array, Uint8Array> = {
  name: "Yjs",
  serverUrl: "ws://localhost:8083",
  createDocBinding: () => YjsBinding(),
  addChild: (doc, text) => {
    doc.getArray<string>("items").push([text]);
  },
  getChildren: (doc) => {
    return doc.getArray<string>("items").toArray();
  },
  getDocChildren: (binding, serializedDoc) => {
    const doc = binding.deserialize(toUint8Array(serializedDoc));
    const children = doc.getArray<string>("items").toArray();
    doc.destroy();
    return children;
  },
  getOpsChildren: (ops) => {
    const tempDoc = new Y.Doc();
    for (const batch of ops) {
      for (const update of batch) {
        Y.applyUpdate(tempDoc, toUint8Array(update));
      }
    }
    const children = tempDoc.getArray<string>("items").toArray();
    tempDoc.destroy();
    return children;
  },
};

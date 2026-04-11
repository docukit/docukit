import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { YjsBinding } from "@docukit/docsync/yjs";

describe("YjsBinding", () => {
  describe("constructor", () => {
    it("creates a binding without templates", () => {
      const binding = YjsBinding();
      expect(binding).toBeDefined();
      /* eslint-disable @typescript-eslint/unbound-method */
      expect(binding.create).toBeTypeOf("function");
      expect(binding.serialize).toBeTypeOf("function");
      expect(binding.deserialize).toBeTypeOf("function");
      expect(binding.onChange).toBeTypeOf("function");
      expect(binding.applyOperations).toBeTypeOf("function");
      expect(binding.dispose).toBeTypeOf("function");
      /* eslint-enable @typescript-eslint/unbound-method */
    });

    it("creates a binding with templates", () => {
      const binding = YjsBinding([{ type: "test" }]);
      expect(binding).toBeDefined();
    });

    it("throws on duplicate template types", () => {
      expect(() => YjsBinding([{ type: "test" }, { type: "test" }])).toThrow(
        "Duplicate doc type: test",
      );
    });
  });

  describe("create", () => {
    it("creates a doc with generated guid when no id provided", () => {
      const binding = YjsBinding();
      const { doc, docId } = binding.create("test");
      expect(doc).toBeInstanceOf(Y.Doc);
      expect(docId).toBe(doc.guid);
      expect(docId).toBeTruthy();
      doc.destroy();
    });

    it("creates a doc with specified id", () => {
      const binding = YjsBinding();
      const { doc, docId } = binding.create("test", "my-custom-id");
      expect(doc.guid).toBe("my-custom-id");
      expect(docId).toBe("my-custom-id");
      doc.destroy();
    });

    it("runs initialize callback from template", () => {
      const initialize = vi.fn((doc: Y.Doc) => {
        doc.getArray("items").push(["hello"]);
      });
      const binding = YjsBinding([{ type: "test", initialize }]);
      const { doc } = binding.create("test");
      expect(initialize).toHaveBeenCalledOnce();
      expect(doc.getArray("items").toArray()).toStrictEqual(["hello"]);
      doc.destroy();
    });

    it("creates empty doc for unknown type (no template match)", () => {
      const binding = YjsBinding([{ type: "other" }]);
      const { doc } = binding.create("test");
      expect(doc).toBeInstanceOf(Y.Doc);
      doc.destroy();
    });
  });

  describe("serialize / deserialize roundtrip", () => {
    it("preserves empty doc state", () => {
      const binding = YjsBinding();
      const { doc: original } = binding.create("test");
      const serialized = binding.serialize(original);
      expect(serialized).toBeInstanceOf(Uint8Array);

      const restored = binding.deserialize(serialized);
      expect(restored).toBeInstanceOf(Y.Doc);

      original.destroy();
      restored.destroy();
    });

    it("preserves Y.Map data", () => {
      const binding = YjsBinding();
      const { doc: original } = binding.create("test");
      const map = original.getMap("data");
      map.set("key", "value");
      map.set("number", 42);

      const serialized = binding.serialize(original);
      const restored = binding.deserialize(serialized);

      const restoredMap = restored.getMap("data");
      expect(restoredMap.get("key")).toBe("value");
      expect(restoredMap.get("number")).toBe(42);

      original.destroy();
      restored.destroy();
    });

    it("preserves Y.Array data", () => {
      const binding = YjsBinding();
      const { doc: original } = binding.create("test");
      const arr = original.getArray("items");
      arr.push(["a", "b", "c"]);

      const serialized = binding.serialize(original);
      const restored = binding.deserialize(serialized);

      expect(restored.getArray("items").toArray()).toStrictEqual([
        "a",
        "b",
        "c",
      ]);

      original.destroy();
      restored.destroy();
    });

    it("preserves Y.Text data", () => {
      const binding = YjsBinding();
      const { doc: original } = binding.create("test");
      const text = original.getText("content");
      text.insert(0, "hello world");

      const serialized = binding.serialize(original);
      const restored = binding.deserialize(serialized);

      expect(restored.getText("content").toJSON()).toBe("hello world");

      original.destroy();
      restored.destroy();
    });

    it("preserves nested Y.Map inside Y.Array", () => {
      const binding = YjsBinding();
      const { doc: original } = binding.create("test");
      const arr = original.getArray<Y.Map<unknown>>("items");
      const item = new Y.Map<unknown>();
      item.set("id", "1");
      item.set("value", "test");
      arr.push([item]);

      const serialized = binding.serialize(original);
      const restored = binding.deserialize(serialized);

      const restoredArr = restored.getArray<Y.Map<unknown>>("items");
      expect(restoredArr.length).toBe(1);
      expect(restoredArr.get(0).get("id")).toBe("1");
      expect(restoredArr.get(0).get("value")).toBe("test");

      original.destroy();
      restored.destroy();
    });
  });

  describe("onChange", () => {
    it("fires callback when doc is modified locally", () => {
      const binding = YjsBinding();
      const { doc } = binding.create("test");
      const cb = vi.fn();

      binding.onChange(doc, cb);
      doc.getMap("data").set("key", "value");

      expect(cb).toHaveBeenCalledOnce();
      const callArg = cb.mock.calls[0]![0] as { operations: Uint8Array };
      expect(callArg.operations).toBeInstanceOf(Uint8Array);

      doc.destroy();
    });

    it("does NOT fire callback when applyOperations is used (remote origin)", () => {
      const binding = YjsBinding();
      const { doc: doc1 } = binding.create("test");
      const { doc: doc2 } = binding.create("test");
      const cb = vi.fn();

      // Capture an update from doc1
      let capturedUpdate: Uint8Array | undefined;
      binding.onChange(doc1, (ev) => {
        capturedUpdate = ev.operations;
      });
      doc1.getMap("data").set("key", "value");
      expect(capturedUpdate).toBeDefined();

      // Apply update to doc2 - onChange should NOT fire
      binding.onChange(doc2, cb);
      binding.applyOperations(doc2, capturedUpdate!);

      expect(cb).not.toHaveBeenCalled();

      doc1.destroy();
      doc2.destroy();
    });

    it("fires for multiple distinct changes", () => {
      const binding = YjsBinding();
      const { doc } = binding.create("test");
      const cb = vi.fn();

      binding.onChange(doc, cb);
      doc.getMap("data").set("a", 1);
      doc.getMap("data").set("b", 2);

      expect(cb).toHaveBeenCalledTimes(2);

      doc.destroy();
    });
  });

  describe("applyOperations", () => {
    it("applies update from one doc to another", () => {
      const binding = YjsBinding();
      const { doc: doc1 } = binding.create("test");
      const { doc: doc2 } = binding.create("test");

      // Make change on doc1 and capture the update
      let capturedUpdate: Uint8Array | undefined;
      binding.onChange(doc1, (ev) => {
        capturedUpdate = ev.operations;
      });
      doc1.getMap("data").set("key", "synced-value");

      // Apply to doc2
      binding.applyOperations(doc2, capturedUpdate!);

      expect(doc2.getMap("data").get("key")).toBe("synced-value");

      doc1.destroy();
      doc2.destroy();
    });

    it("handles sequential operations", () => {
      const binding = YjsBinding();
      const { doc: doc1 } = binding.create("test");
      const { doc: doc2 } = binding.create("test");

      const updates: Uint8Array[] = [];
      binding.onChange(doc1, (ev) => {
        updates.push(ev.operations);
      });

      doc1.getArray("items").push(["first"]);
      doc1.getArray("items").push(["second"]);

      for (const update of updates) {
        binding.applyOperations(doc2, update);
      }

      expect(doc2.getArray("items").toArray()).toStrictEqual([
        "first",
        "second",
      ]);

      doc1.destroy();
      doc2.destroy();
    });
  });

  describe("dispose", () => {
    it("destroys the doc", () => {
      const binding = YjsBinding();
      const { doc } = binding.create("test");

      const destroySpy = vi.spyOn(doc, "destroy");
      binding.dispose(doc);

      expect(destroySpy).toHaveBeenCalledOnce();
    });
  });

  describe("full sync simulation", () => {
    it("two docs stay in sync via serialize/deserialize + operations", () => {
      const binding = YjsBinding();
      const { doc: doc1 } = binding.create("test");

      // Initial state on doc1
      doc1.getMap("data").set("name", "Alice");
      doc1.getArray("items").push([1, 2, 3]);

      // "Send" full state to doc2 via serialize/deserialize
      const serialized = binding.serialize(doc1);
      const doc2 = binding.deserialize(serialized);

      expect(doc2.getMap("data").get("name")).toBe("Alice");
      expect(doc2.getArray("items").toArray()).toStrictEqual([1, 2, 3]);

      // Now capture incremental updates from doc1
      const updates: Uint8Array[] = [];
      binding.onChange(doc1, (ev) => updates.push(ev.operations));

      doc1.getMap("data").set("name", "Bob");
      doc1.getArray("items").push([4]);

      // Apply incremental updates to doc2
      for (const update of updates) {
        binding.applyOperations(doc2, update);
      }

      expect(doc2.getMap("data").get("name")).toBe("Bob");
      expect(doc2.getArray("items").toArray()).toStrictEqual([1, 2, 3, 4]);

      doc1.destroy();
      doc2.destroy();
    });
  });
});

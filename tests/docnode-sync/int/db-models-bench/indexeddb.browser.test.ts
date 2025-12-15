import { test, expect } from "vitest";
import { Doc, string } from "docnode";
import { IndexedDBProvider } from "@docnode/sync/indexeddb";
import { customConsoleTable } from "./customConsoleTable.js";

const DEBUG = false;

const A = {
  type: "A" as const,
  state: {
    foo: string(""),
  },
};

test("IndexedDB - Benchmarking 1 row per docnode vs 1 row per doc", async () => {
  const QUANTITY = 1000;
  const providers = [IndexedDBProvider, IndexedDBProvider];

  const results: Record<"get" | "save" | "_name", number | string>[] = [];
  for (const [index, Provider] of providers.entries()) {
    const provider = new Provider();
    await provider.cleanDB();
    await new Promise((resolve) => setTimeout(resolve, 5)); // Without this, the test fails half of the time
    const doc = new Doc({ extensions: [{ nodes: [A] }] });
    void provider
      .saveOnChange(doc, () => void {})
      .then(() => performance.mark(`end save ${Provider.name} - ${index}`));
    const nodes = Array.from({ length: QUANTITY }).map((_, i) => {
      const node = doc.createNode(A);
      node.state.foo.set(i.toString());
      return node;
    });
    doc.root.append(...nodes);
    performance.mark(`start save ${Provider.name} - ${index}`);

    doc.forceCommit();
    performance.mark(`start get ${Provider.name} - ${index}`);
    const jsonDoc = await provider.getJsonDoc(doc.root.id);
    performance.mark(`end get ${Provider.name} - ${index}`);
    expect(jsonDoc?.[3]?.length).toBe(QUANTITY);
    results.push({
      _name: `${Provider.name} - ${index}`,
      get: performance.measure(
        `get ${Provider.name} - ${index}`,
        `start get ${Provider.name} - ${index}`,
        `end get ${Provider.name} - ${index}`,
      ).duration,
      save: performance.measure(
        `save ${Provider.name} - ${index}`,
        `start save ${Provider.name} - ${index}`,
        `end save ${Provider.name} - ${index}`,
      ).duration,
    });
  }
  if (DEBUG) customConsoleTable(results);
});

// From previous tests:
// class IndexedDBProviderSplitted implements ClientProvider {}

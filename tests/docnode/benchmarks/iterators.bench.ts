/**
 * To run the benchmarks:
 * - pnpm vitest bench
 *
 * NOTE:
 * I would love to use an iterator here to benefit from all the built-in helper methods
 * without having to implement them manually. However, iterators tend to be memory-intensive
 * and can introduce performance overhead. For benchmarking details, see _tests/iterators.bench.ts.
 *
 * Additionally, trees may not be the ideal use case for iterators because tree nodes don’t
 * have a single, obvious "next" pointer. This means traversal requires recursion or a stack,
 * which further increases the memory cost of using iterators in what are essentially linear traversals.
 */

import { Doc, defineNode, string } from "@docukit/docnode";
import { children, descendants, nextSiblings } from "./shared.js";
import { assert, bench, describe, wrapper } from "./utils.js";
import { TextExtension } from "../utils.js";

void (await wrapper(async () => {
  const Text = defineNode({ type: "text", state: { value: string("") } });

  // Helper function to create text nodes
  const text = (doc: Doc, ...values: string[]) =>
    values.map((value) => {
      const node = doc.createNode(Text);
      node.state.value.set(value);
      return node;
    });

  const doc = new Doc({ type: "root", extensions: [TextExtension] });
  let count = 0;
  const EXPECTED = 100_000;
  const increment = () => {
    count++;
  };

  const assert2 = (expected: number, actual: number, name: string) => {
    assert(
      expected === actual,
      `expected ${expected}, got ${actual} (${name})`,
    );
  };

  // Setup: populate document with test data
  for (let i = 0; i < EXPECTED; i++) {
    doc.root.append(...text(doc, `text ${i}`));
  }

  describe("forEach descendant", () => {
    bench("PRODUCTION CURRENT", () => {
      count = 0;
      doc.root.descendants().forEach(increment);
      assert2(EXPECTED, count, "desc. PRODUCTION CURRENT");
    });

    bench("desc. custom.toArray", () => {
      count = 0;
      descendants.customToArray(doc.root).forEach(increment);
      assert2(EXPECTED, count, "desc. custom.toArray");
    });

    bench("desc. generator", () => {
      count = 0;
      descendants.generator(doc.root).forEach(increment);
      assert2(EXPECTED, count, "desc. generator");
    });

    bench("desc. iterator class", () => {
      count = 0;
      descendants.iteratorClass(doc.root).forEach(increment);
      assert2(EXPECTED, count, "desc. iterator class");
    });

    bench("desc. custom", () => {
      count = 0;
      descendants.custom(doc.root, increment);
      assert2(EXPECTED, count, "desc. custom");
    });

    bench("desc. customPath", () => {
      count = 0;
      descendants.customPath(doc.root, increment);
      assert2(EXPECTED, count, "desc. customPath");
    });

    bench("desc. customDeepLevel", () => {
      count = 0;
      descendants.customDeepLevel(doc.root, increment);
      assert2(EXPECTED, count, "desc. customDeepLevel");
    });

    bench("desc. customStack", () => {
      count = 0;
      descendants.customStack(doc.root, increment);
      assert2(EXPECTED, count, "desc. customStack");
    });
  });

  describe("forEach children", () => {
    bench("children custom.toArray", () => {
      count = 0;
      children.customToArray(doc.root).forEach(increment);
      assert2(EXPECTED, count, "children custom.toArray");
    });

    bench("children generator", () => {
      count = 0;
      children.generator(doc.root).forEach(increment);
      assert2(EXPECTED, count, "children generator");
    });

    bench("children iterator class", () => {
      count = 0;
      children.iteratorClass(doc.root).forEach(increment);
      assert2(EXPECTED, count, "children iterator class");
    });

    bench("children custom", () => {
      count = 0;
      children.custom(doc.root, increment);
      assert2(EXPECTED, count, "children custom");
    });
  });

  describe("forEach next siblings", () => {
    bench("next generator", () => {
      count = 0;
      nextSiblings.generator(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next generator");
    });

    bench("next iterator manual", () => {
      count = 0;
      nextSiblings.iteratorManual(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next iterator manual");
    });

    bench("next iterator setPrototype", () => {
      count = 0;
      nextSiblings.iteratorsetPrototype(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next iterator setPrototype");
    });

    bench("next iterator createObject", () => {
      count = 0;
      nextSiblings.iteratorCreateObject(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next iterator createObject");
    });

    bench("next iterator class", () => {
      count = 0;
      nextSiblings.iteratorClass(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next iterator class");
    });

    bench("next custom", () => {
      count = 0;
      nextSiblings.custom(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next custom");
    });

    bench("next custom.toArray", () => {
      count = 0;
      nextSiblings.customToArray(doc.root.first!).forEach(increment);
      assert2(EXPECTED - 1, count, "next custom.toArray");
    });
  });
}));

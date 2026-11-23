import { describe, expect, test } from "vitest";

import { defineNode, Doc, type Operations } from "@docukit/docnode";
import { defineText, labelsEngine } from "@docukit/docnode/crdt";

import { ROOT_ID } from "./utils.js";

/** A paragraph whose text is `defineText` of `@docukit/docnode/crdt`. */
const Line = defineNode({
  type: "line",
  state: { t: defineText({ inherit: { bold: "origin" } }) },
});

const config = (peer: string) => {
  let clock = 0;
  return {
    type: "root",
    id: ROOT_ID,
    extensions: [{ nodes: [Line] }],
    crdt: labelsEngine(),
    nodeIdGenerator: {
      generate: () => `${peer}.${clock++}`,
      validate: () => true,
    },
  };
};

describe("defineText of @docukit/docnode/crdt", () => {
  test("is the text of the engine: replicas converge and reload", () => {
    const [a, b] = ["a", "b"].map((peer) => new Doc(config(peer)));
    const sent: Operations[] = [];
    a!.onChange((event) => sent.push(event.operations));
    const line = a!.createNode(Line);
    a!.root.append(line);
    line.state.t.insert(0, "hello");
    line.state.t.format(0, 2, "bold", true);
    a!.forceCommit();
    for (const batch of sent) b!.applyOperations(batch);
    b!.forceCommit();
    const copy = b!.getNodeById(line.id);
    expect(copy?.is(Line) && copy.state.t.spans()).toStrictEqual(
      line.state.t.spans(),
    );
    const loaded = Doc.fromJSON(config("c"), a!.toJSON());
    const again = loaded.getNodeById(line.id);
    expect(again?.is(Line) && again.state.t.get()).toBe("hello");
  });

  test("needs a CRDT engine", () => {
    expect(
      () =>
        new Doc({ type: "root", id: ROOT_ID, extensions: [{ nodes: [Line] }] }),
    ).toThrowError("needs a CRDT engine");
  });
});

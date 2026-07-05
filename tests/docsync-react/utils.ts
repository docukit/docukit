import { defineNode, string, type DocConfig } from "@docukit/docnode";

export const ChildNode = defineNode({
  type: "child",
  state: { value: string("") },
});

export const docConfig: DocConfig = {
  type: "test",
  extensions: [{ nodes: [ChildNode] }],
};

export const id = {
  ending: (ending: string) => `${7}${ending.padStart(25, "0")}`,
};

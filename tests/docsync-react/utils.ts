import type { DocConfig } from "docnode";

export const docConfig: DocConfig = {
  type: "test",
  extensions: [{ nodes: [{ type: "test", state: {} }] }],
};

export const id = {
  ending: (ending: string) => `${7}${ending.padStart(25, "0")}`,
};

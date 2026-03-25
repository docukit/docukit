import { $getRoot, createEditor } from "lexical";
import { expect, test } from "vitest";

test("batch updates", () => {
  const editor = createEditor();
  const logOp: string[] = [];
  editor.registerUpdateListener(() => {
    logOp.push("change");
  });
  editor.update(() => {
    $getRoot().clear();
    logOp.push("update1");
  });
  expect(logOp).toStrictEqual(["update1"]);
  editor.update(() => {
    logOp.push("update2");
  });
  expect(logOp).toStrictEqual(["update1", "update2"]);
  void Promise.resolve().then(() => {
    expect(logOp).toStrictEqual(["update1", "update2", "change"]);
  });
  expect(logOp).toStrictEqual(["update1", "update2"]);
  setTimeout(() => {
    expect(logOp).toStrictEqual(["update1", "update2", "change"]);
  }, 0);
});

test("prevent batch updates with discrete", async () => {
  const editor = createEditor();
  const logOp: string[] = [];
  editor.registerUpdateListener(() => {
    logOp.push("change");
  });
  editor.update(() => {
    $getRoot().clear();
    logOp.push("update1");
  });
  await Promise.resolve();
  expect(logOp).toStrictEqual(["update1", "change"]);
  editor.update(() => {
    $getRoot().clear();
    logOp.push("update2");
  });
  await Promise.resolve();
  expect(logOp).toStrictEqual(["update1", "change", "update2", "change"]);
});

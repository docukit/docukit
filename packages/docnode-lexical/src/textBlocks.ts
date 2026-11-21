import {
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";

// ----- selection as (block, offset in its text value) ----------------------

/** The offset of a Lexical point inside its text block's value. */
export function $offsetInBlock(
  block: ElementNode,
  key: string,
  offset: number,
  type: "text" | "element",
): number {
  let total = 0;
  let found = false;
  const walk = (node: LexicalNode): void => {
    if (found) return;
    if (node.getKey() === key && type === "text") {
      total += offset;
      found = true;
      return;
    }
    if ($isElementNode(node)) {
      const children = node.getChildren();
      const limit =
        node.getKey() === key
          ? Math.min(offset, children.length)
          : children.length;
      for (let index = 0; index < limit && !found; index++)
        walk(children[index]!);
      if (node.getKey() === key) found = true;
      return;
    }
    total += $isTextNode(node) ? node.getTextContentSize() : 1;
  };
  walk(block);
  return total;
}

export type BlockPoint = {
  key: string;
  offset: number;
  type: "text" | "element";
};

/** Resolves an offset inside a text block's value to a Lexical point. */
export function $pointAtOffset(block: ElementNode, offset: number): BlockPoint {
  let remaining = offset;
  let point: BlockPoint | undefined;
  const walk = (node: LexicalNode): void => {
    if (point) return;
    if ($isTextNode(node)) {
      const size = node.getTextContentSize();
      if (remaining <= size)
        point = { key: node.getKey(), offset: remaining, type: "text" };
      else remaining -= size;
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) walk(child);
      return;
    }
    remaining = Math.max(0, remaining - 1);
  };
  walk(block);
  return (
    point ?? {
      key: block.getKey(),
      offset: block.getChildrenSize(),
      type: "element",
    }
  );
}

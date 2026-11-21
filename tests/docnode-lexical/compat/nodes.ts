import { CodeHighlightNode, CodeNode } from "@lexical/code-core";
import { HashtagNode } from "@lexical/hashtag";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { MarkNode } from "@lexical/mark";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import {
  DecoratorNode,
  ElementNode,
  type SerializedElementNode,
  type SerializedLexicalNode,
} from "lexical";

// Only Lexical imports: the script that writes `fixtures.json` with the code
// of `main` uses these nodes too.

/** An inline element of the app's own. */
export class ChipNode extends ElementNode {
  static override getType() {
    return "chip";
  }
  static override clone(node: ChipNode) {
    return new ChipNode(node.__key);
  }
  static override importJSON(json: SerializedElementNode) {
    return new ChipNode().updateFromJSON(json);
  }
  override isInline() {
    return true;
  }
}

type SerializedEmoji = SerializedLexicalNode & { name: string };

/** An inline decorator with a field of its own. */
export class EmojiNode extends DecoratorNode<undefined> {
  __name: string;
  static override getType() {
    return "emoji";
  }
  static override clone(node: EmojiNode) {
    return new EmojiNode(node.__name, node.__key);
  }
  static override importJSON(json: SerializedEmoji) {
    return new EmojiNode(json.name);
  }
  constructor(name = "", key?: string) {
    super(key);
    this.__name = name;
  }
  override exportJSON(): SerializedEmoji {
    return { ...super.exportJSON(), name: this.__name };
  }
  override isInline() {
    return true;
  }
  override decorate() {
    return undefined;
  }
}

/** A block that is not text. */
export class DividerNode extends DecoratorNode<undefined> {
  static override getType() {
    return "divider";
  }
  static override clone(node: DividerNode) {
    return new DividerNode(node.__key);
  }
  static override importJSON() {
    return new DividerNode();
  }
  override isInline() {
    return false;
  }
  override decorate() {
    return undefined;
  }
}

/** The nodes of the editors of these tests. */
export const NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  MarkNode,
  HashtagNode,
  CodeNode,
  CodeHighlightNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  ChipNode,
  EmojiNode,
  DividerNode,
];

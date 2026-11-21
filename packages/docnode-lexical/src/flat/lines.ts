import type { Json, TextSpan } from "@docukit/docnode";
import {
  $createLineBreakNode,
  $createTabNode,
  $createTextNode,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRootOrShadowRoot,
  $isTextNode,
  $parseSerializedNode,
  type ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
  type TextNode,
} from "lexical";
import { FORMAT_KEYS, inlineKey, OBJECT, PARAGRAPH } from "./inherit.js";

// A container's text is its lines one after the other, each ended by
// `PARAGRAPH`, whose state holds the block (its type and fields). DEL: one
// byte in a JSON string, never typed, and apart from the `\n` of soft line
// breaks. `OBJECT` is an inline decorator.

/** One block of a container, as its letters say. */
export type Line = {
  /** Its inline letters, by runs of equal state. */
  spans: TextSpan[];
  /** The state of its paragraph letter. */
  attrs: Record<string, Json>;
  /** Without a paragraph letter: text after the last one (never written so). */
  open: boolean;
  /** `spans` and `attrs` as one string, to compare lines. */
  key: string;
  /** Its letters, with the paragraph letter. */
  length: number;
};

export function makeLine(
  spans: TextSpan[],
  attrs: Record<string, Json>,
  open = false,
): Line {
  let length = open ? 0 : 1;
  for (const span of spans) length += span.text.length;
  return {
    spans,
    attrs,
    open,
    key: JSON.stringify([spans, attrs, open]),
    length,
  };
}

/** The spans of a whole line, its paragraph letter included. */
export function lineSpans(line: Line): TextSpan[] {
  if (line.open) return line.spans;
  return [...line.spans, { text: PARAGRAPH, attrs: line.attrs }];
}

/** Splits a container's spans into lines. */
export function linesOf(spans: TextSpan[]): Line[] {
  const lines: Line[] = [];
  let current: TextSpan[] = [];
  for (const span of spans) {
    let text = span.text;
    let at = text.indexOf(PARAGRAPH);
    while (at !== -1) {
      if (at > 0) current.push({ text: text.slice(0, at), attrs: span.attrs });
      lines.push(makeLine(current, span.attrs));
      current = [];
      text = text.slice(at + 1);
      at = text.indexOf(PARAGRAPH);
    }
    if (text.length > 0) current.push({ text, attrs: span.attrs });
  }
  if (current.length > 0) lines.push(makeLine(current, {}, true));
  return lines;
}

// ----- compact JSON of elements --------------------------------------------

/** What a Lexical element repeats in its JSON (a paragraph has exactly these). */
const DEFAULTS: Record<string, Json> = {
  direction: null,
  format: "",
  indent: 0,
  textFormat: 0,
  textStyle: "",
  type: "paragraph",
  version: 1,
};
/** One letter per common field: each field is a key of its own letter state. */
const SHORT: Record<string, string> = {
  type: "T",
  tag: "H",
  format: "A",
  indent: "I",
  direction: "D",
  textFormat: "F",
  textStyle: "S",
  version: "V",
  listType: "L",
  checked: "K",
  start: "N",
};
const LONG: Record<string, string> = Object.fromEntries(
  Object.entries(SHORT).map(([long, short]) => [short, long]),
);
/** Short values of common block types. */
const TYPE_ALIAS: Record<string, string> = {
  heading: "h",
  quote: "q",
  list: "l",
  listitem: "i",
  code: "c",
  link: "a",
};
const TYPE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_ALIAS).map(([name, alias]) => [alias, name]),
);
/** The chain of wrappers (a list, a nested list item) a line is in. */
const WRAPPERS = "W";
/** A block that is not text: its whole JSON, written last writer wins. */
const EMBED = "E";

/** Fields that Lexical recomputes, kept out of the letters. */
const volatile = (type: Json, key: string) =>
  type === "listitem" && key === "value";

const listOf = (value: Json | undefined): readonly Json[] | undefined =>
  Array.isArray(value) ? value : undefined;

/** An object, as JSON gives it: its values are JSON too. */
const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value`, which must be an object: anything else is bad data. */
function toRecord(value: unknown, what: string): Record<string, Json> {
  if (!isRecord(value))
    throw new Error(
      `Expected ${what} to be an object: ${JSON.stringify(value)}`,
    );
  return value;
}

/** A node's exported JSON, as plain JSON. */
function jsonRecord(value: SerializedLexicalNode): Record<string, Json> {
  const json: unknown = JSON.parse(JSON.stringify(value));
  return toRecord(json, "a serialized node");
}

/** The other name of a block type, when it has one. */
const renamed = (names: Record<string, string>, value: Json) =>
  typeof value === "string" ? (names[value] ?? value) : value;

/** An element's JSON without its children, its defaults left out. */
function compactElement(node: ElementNode): Record<string, Json> {
  const { children: _children, ...json } = jsonRecord(node.exportJSON());
  const out: Record<string, Json> = {};
  for (const key in json) {
    const value = json[key]!;
    if (volatile(json.type ?? null, key)) continue;
    if (
      key in DEFAULTS &&
      JSON.stringify(DEFAULTS[key]) === JSON.stringify(value)
    )
      continue;
    out[SHORT[key] ?? key] =
      key === "type" ? renamed(TYPE_ALIAS, value) : value;
  }
  return out;
}

/** The serialized element `compactElement` wrote, with no children. */
function expandElement(attrs: Record<string, Json>): SerializedLexicalNode {
  // Defaults a node does not have are left for it to ignore.
  const json: Record<string, Json> = { ...DEFAULTS };
  for (const key in attrs) {
    if (key === WRAPPERS || key === EMBED) continue;
    const value = attrs[key]!;
    json[LONG[key] ?? key] = key === "T" ? renamed(TYPE_NAME, value) : value;
  }
  json.children = [];
  return serialized(json);
}

function serialized(value: Json): SerializedLexicalNode {
  const { type, version, ...rest } = toRecord(value, "a serialized node");
  if (typeof type !== "string") throw new Error("Expected a node type");
  return { ...rest, type, version: typeof version === "number" ? version : 1 };
}

/** A node's JSON with its children, as Lexical writes a whole tree. */
export function $exportTree(node: LexicalNode): Record<string, Json> {
  const json = jsonRecord(node.exportJSON());
  if ($isElementNode(node))
    json.children = node.getChildren().map((child) => $exportTree(child));
  return json;
}

// ----- inline content ---------------------------------------------------

const isInline = (node: LexicalNode): boolean =>
  $isTextNode(node) ||
  $isLineBreakNode(node) ||
  ($isElementNode(node) && node.isInline()) ||
  ($isDecoratorNode(node) && node.isInline());

/** A block whose children are all inline: one line. */
export const $isTextBlock = (node: LexicalNode): node is ElementNode =>
  $isElementNode(node) &&
  !$isRootOrShadowRoot(node) &&
  !node.isInline() &&
  node.getChildren().every(isInline);

/** An element of blocks only, none of them a shadow root: its lines go flat. */
export const $isWrapper = (node: LexicalNode): node is ElementNode =>
  $isElementNode(node) &&
  !$isRootOrShadowRoot(node) &&
  !node.isInline() &&
  node.getChildren().every((child) => $isTextBlock(child) || $isWrapper(child));

function textAttributes(node: TextNode): Record<string, Json> {
  const attrs: Record<string, Json> = {};
  const format = node.getFormat();
  for (let bit = 0; bit < FORMAT_KEYS.length; bit++)
    if (format & (1 << bit)) attrs[FORMAT_KEYS[bit]!] = 1;
  if (node.getStyle()) attrs.y = node.getStyle();
  if (node.getMode() !== "normal") attrs.m = node.getMode();
  if (node.getDetail()) attrs.d = node.getDetail();
  if (node.getType() !== "text" && node.getType() !== "tab") {
    const {
      text: _text,
      format: _format,
      style: _style,
      mode: _mode,
      detail: _detail,
      version: _version,
      ...rest
    } = jsonRecord(node.exportJSON());
    attrs.n = rest;
  }
  return attrs;
}

/** A text block's inline content as spans. */
export function $readSpans(block: ElementNode): TextSpan[] {
  const spans: TextSpan[] = [];
  let lastKey = "";
  const push = (text: string, attrs: Record<string, Json>) => {
    // A DEL typed or pasted would end the line: it is dropped.
    if (text.includes(PARAGRAPH)) text = text.split(PARAGRAPH).join("");
    if (text.length === 0) return;
    const key = JSON.stringify(attrs);
    if (spans.length > 0 && key === lastKey)
      spans[spans.length - 1]!.text += text;
    else {
      spans.push({ text, attrs });
      lastKey = key;
    }
  };
  const walk = (node: LexicalNode, inherited: Record<string, Json>) => {
    if ($isTextNode(node))
      push(
        node.getTextContent(),
        sorted({ ...inherited, ...textAttributes(node) }),
      );
    else if ($isLineBreakNode(node)) push("\n", inherited);
    else if ($isDecoratorNode(node))
      push(OBJECT, sorted({ ...inherited, e: jsonRecord(node.exportJSON()) }));
    else if ($isElementNode(node)) {
      const { T: _type, ...value } = compactElement(node);
      const attrs = sorted({
        ...inherited,
        [inlineKey(node.getType())]: value,
      });
      for (const child of node.getChildren()) walk(child, attrs);
    }
  };
  for (const child of block.getChildren()) walk(child, {});
  return spans;
}

/** Keys in order, as the text store gives them back. */
function sorted(attrs: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const key of Object.keys(attrs).sort()) out[key] = attrs[key]!;
  return out;
}

function $textNode(text: string, attrs: Record<string, Json>): LexicalNode {
  let format = 0;
  for (let bit = 0; bit < FORMAT_KEYS.length; bit++)
    if (attrs[FORMAT_KEYS[bit]!] !== undefined) format |= 1 << bit;
  const custom = attrs.n;
  const node = custom
    ? $parseSerializedNode(
        serialized({
          ...toRecord(custom, "a text node's fields"),
          text,
          format,
          style: attrs.y ?? "",
          mode: attrs.m ?? "normal",
          detail: attrs.d ?? 0,
        }),
      )
    : $createTextNode(text).setFormat(format);
  if (!$isTextNode(node)) throw new Error(`Expected a text node: ${text}`);
  if (typeof attrs.y === "string") node.setStyle(attrs.y);
  const mode = attrs.m;
  if (mode === "normal" || mode === "token" || mode === "segmented")
    node.setMode(mode);
  if (typeof attrs.d === "number" && !custom) node.setDetail(attrs.d);
  return node;
}

function $leafNodes(span: TextSpan): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  if (span.attrs.e !== undefined) {
    for (const _letter of span.text)
      nodes.push($parseSerializedNode(serialized(span.attrs.e)));
    return nodes;
  }
  span.text.split("\n").forEach((line, lineIndex) => {
    if (lineIndex > 0) nodes.push($createLineBreakNode());
    line.split("\t").forEach((segment, tabIndex) => {
      if (tabIndex > 0) nodes.push($createTabNode());
      if (segment.length > 0) nodes.push($textNode(segment, span.attrs));
    });
  });
  return nodes;
}

function $inlineNodes(spans: TextSpan[]): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  let index = 0;
  while (index < spans.length) {
    const span = spans[index]!;
    const elementKey = Object.keys(span.attrs).find((key) =>
      key.startsWith("@"),
    );
    if (elementKey === undefined) {
      nodes.push(...$leafNodes(span));
      index++;
      continue;
    }
    const value = span.attrs[elementKey]!;
    const json = JSON.stringify(value);
    const group: TextSpan[] = [];
    while (
      index < spans.length &&
      JSON.stringify(spans[index]!.attrs[elementKey]) === json
    ) {
      const { [elementKey]: _removed, ...attrs } = spans[index]!.attrs;
      group.push({ text: spans[index]!.text, attrs });
      index++;
    }
    const type = elementKey === "@" ? "link" : elementKey.slice(1);
    const element = $parseSerializedNode(
      expandElement({
        ...toRecord(value, "an inline element"),
        T: TYPE_ALIAS[type] ?? type,
      }),
    );
    if ($isElementNode(element)) element.append(...$inlineNodes(group));
    nodes.push(element);
  }
  return nodes;
}

// ----- blocks -----------------------------------------------------------

/** The lines of a top-level node, and of its wrapped blocks. */
export function $readLines(
  node: LexicalNode,
  out: Line[],
  wrappers: Json[] = [],
) {
  const withWrappers = (attrs: Record<string, Json>) =>
    wrappers.length > 0 ? { ...attrs, [WRAPPERS]: wrappers } : attrs;
  if ($isTextBlock(node)) {
    out.push(
      makeLine($readSpans(node), sorted(withWrappers(compactElement(node)))),
    );
  } else if ($isWrapper(node) && node.getChildrenSize() > 0) {
    const chain = [...wrappers, compactElement(node)];
    for (const child of node.getChildren()) $readLines(child, out, chain);
  } else {
    out.push(makeLine([], withWrappers({ [EMBED]: $exportTree(node) })));
  }
}

/** Where each top-level node starts: lines that share a first wrapper go together. */
export function unitStarts(lines: readonly Line[]): number[] {
  const starts: number[] = [];
  let previous: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const chain = lines[index]!.attrs[WRAPPERS];
    const first = Array.isArray(chain) ? JSON.stringify(chain[0]) : undefined;
    if (first === undefined || first !== previous) starts.push(index);
    previous = first;
  }
  return starts;
}

function $block(line: Line): LexicalNode {
  const embed = line.attrs[EMBED];
  if (embed !== undefined) return $parseSerializedNode(serialized(embed));
  const block = $parseSerializedNode(expandElement(line.attrs));
  if ($isElementNode(block)) block.append(...$inlineNodes(line.spans));
  return block;
}

/** The top-level node of lines that make one (see `unitStarts`). */
export function $buildUnit(lines: readonly Line[]): LexicalNode {
  const chainOf = (line: Line): readonly Json[] => {
    const chain: Json | undefined = line.attrs[WRAPPERS];
    return listOf(chain) ?? [];
  };
  const first = chainOf(lines[0]!);
  if (first.length === 0) return $block(lines[0]!);
  // Open wrappers, outermost first, each with its JSON.
  const stack: { node: ElementNode; json: string }[] = [];
  for (const line of lines) {
    const chain = chainOf(line);
    let depth = 0;
    while (
      depth < stack.length &&
      depth < chain.length &&
      stack[depth]!.json === JSON.stringify(chain[depth])
    )
      depth++;
    stack.length = depth;
    for (let at = depth; at < chain.length; at++) {
      const wrapper = $parseSerializedNode(
        expandElement(toRecord(chain[at], "a wrapper")),
      );
      if (!$isElementNode(wrapper)) throw new Error("Expected a wrapper");
      if (at > 0) stack[at - 1]!.node.append(wrapper);
      stack.push({ node: wrapper, json: JSON.stringify(chain[at]) });
    }
    stack.at(-1)!.node.append($block(line));
  }
  // The outermost wrapper: every line of a unit is inside it.
  return stack[0]!.node;
}

/** The node of each line of a top-level node, in order (see `$readLines`). */
export function $lineNodes(node: LexicalNode, out: LexicalNode[]) {
  if ($isTextBlock(node)) out.push(node);
  else if ($isWrapper(node) && node.getChildrenSize() > 0)
    for (const child of node.getChildren()) $lineNodes(child, out);
  else out.push(node);
}

import type { Doc, Json, TextHandle, TextSpan } from "@docukit/docnode";
import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";

import { SKIP_UNDO_TAG } from "../constants.js";
import { bindPresence } from "../presence/index.js";
import type { PresencePoints } from "../presence/types.js";
import { setupHistory } from "../history.js";
import { $offsetInBlock, $pointAtOffset } from "../textBlocks.js";
import type { syncLexicalWithDocPresenceOptions } from "../types.js";
import {
  $buildUnit,
  $exportTree,
  $isTextBlock,
  $lineNodes,
  $readLines,
  lineSpans,
  linesOf,
  unitStarts,
  type Line,
} from "./lines.js";

/** Where a Lexical point is: a line of the cache and an offset in it. */
type LinePoint = { line: number; offset: number };
/** A selection as lines and offsets (see `$pointOf`). */
type LineSelection = { anchor: LinePoint; focus: LinePoint };

/**
 * The point of the selection's anchor or focus as a line and an offset, if
 * it is in a text block of a top-level node `firstLineOf` knows.
 */
function $pointOf(
  which: "anchor" | "focus",
  firstLineOf: (key: NodeKey) => number | undefined,
): LinePoint | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return undefined;
  const point = selection[which];
  let block: LexicalNode | undefined = point.getNode();
  while (block && !$isTextBlock(block)) block = block.getParent() ?? undefined;
  if (!block || !$isElementNode(block)) return undefined;
  const top = block.getTopLevelElement();
  if (!top) return undefined;
  const first = firstLineOf(top.getKey());
  if (first === undefined) return undefined;
  const nodes: LexicalNode[] = [];
  $lineNodes(top, nodes);
  const index = nodes.findIndex((each) => each.is(block));
  if (index === -1) return undefined;
  return {
    line: first + index,
    offset: $offsetInBlock(block, point.key, point.offset, point.type),
  };
}

/**
 * Syncs a Lexical editor with the text of a container (the document root):
 * one text whose paragraph letters end its blocks. The binding keeps the
 * lines Lexical shows, and the top-level node of each run of them, so an
 * edit only reads and writes the blocks it touched.
 */
export function syncFlat(
  editor: LexicalEditor,
  doc: Doc,
  text: TextHandle,
  options: syncLexicalWithDocPresenceOptions | undefined,
): () => void {
  /** The lines of the container, as Lexical shows them. */
  let lines: Line[] = [];
  /** The key of each top-level node, and how many lines it has. */
  let keys: NodeKey[] = [];
  let counts: number[] = [];
  /** While this binding writes the document: its change is not read back. */
  let writing = false;

  /** `keys` by key, and the first line of each node, built when needed. */
  let indexOfKey: Map<NodeKey, number> | undefined;
  let cachedStarts: number[] | undefined;
  const changedKeys = () => {
    indexOfKey = undefined;
    cachedStarts = undefined;
  };
  const startsOf = () => {
    if (cachedStarts) return cachedStarts;
    const starts = [0];
    for (const count of counts) starts.push(starts.at(-1)! + count);
    return (cachedStarts = starts);
  };
  const unitOfKey = (key: NodeKey) => {
    indexOfKey ??= new Map(keys.map((each, index) => [each, index]));
    return indexOfKey.get(key);
  };
  const offsetOfLine = (line: number) => {
    let offset = 0;
    for (let index = 0; index < line; index++) offset += lines[index]!.length;
    return offset;
  };
  /** The top-level node a line is in, by its index in `keys`. */
  const unitOfLine = (line: number) => {
    const starts = startsOf();
    let low = 0;
    let high = counts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= line) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  /** Reads the top-level keys and the lines of each node again. */
  const $resync = () => {
    const fresh: Line[] = [];
    const freshCounts: number[] = [];
    const root = $getRoot();
    for (const child of root.getChildren()) {
      const before = fresh.length;
      $readLines(child, fresh);
      freshCounts.push(fresh.length - before);
    }
    keys = root.getChildrenKeys();
    counts = freshCounts;
    lines = fresh;
    changedKeys();
  };

  /**
   * Runs `work` in an update of its own, tagged so the sync below skips it.
   * Called from a listener, Lexical runs it right after the current update:
   * `work` reads the cache when it runs, not now.
   */
  const schedule = (work: () => void) =>
    editor.update(work, {
      discrete: true,
      tag: COLLABORATION_TAG,
      onUpdate: () => {
        // Lexical keeps the tag of an update that changed no node for the
        // next one: the user's next keystroke would carry it, look remote,
        // and never reach the document.
        editor._updateTags.delete(COLLABORATION_TAG);
        // Transforms (like merging two lists) may have changed the nodes.
        editor.getEditorState().read(() => {
          const root = $getRoot();
          const now = root.getChildrenKeys();
          if (
            now.length !== keys.length ||
            now.some((key, i) => key !== keys[i])
          )
            $resync();
        });
      },
    });

  /**
   * Replaces the top-level nodes `[from, oldEnd)` with nodes built from the
   * lines of `next` that stand for them (the lines around them are the same
   * in both). `check`: nothing changes when the built nodes are the same.
   */
  const $rewrite = (
    from: number,
    oldEnd: number,
    next: Line[],
    check: boolean,
  ) => {
    const oldStarts = startsOf();
    const firstLine = oldStarts[from]!;
    const oldLastLine = oldStarts[oldEnd]!;
    const region = next.slice(
      firstLine,
      next.length - (lines.length - oldLastLine),
    );
    const regionStarts = unitStarts(region);
    regionStarts.push(region.length);
    const units: Line[][] = [];
    for (let index = 0; index + 1 < regionStarts.length; index++)
      units.push(region.slice(regionStarts[index], regionStarts[index + 1]));
    const root = $getRoot();
    const built = units.map((unit) => $buildUnit(unit));
    if (check && built.length === oldEnd - from) {
      let same = true;
      for (let index = 0; index < built.length && same; index++) {
        const node = $getNodeByKey(keys[from + index]!);
        same =
          !!node &&
          JSON.stringify($exportTree(node)) ===
            JSON.stringify($exportTree(built[index]!));
      }
      if (same) return;
    }
    const selection = $captureLines();
    const old = lines;
    const oldNodes = root.getChildren().slice(from, oldEnd);
    const after = root.getChildAtIndex(oldEnd);
    for (const node of oldNodes) node.remove();
    if (after) for (const node of built) after.insertBefore(node);
    else root.append(...built);
    lines = next;
    keys.splice(from, oldEnd - from, ...built.map((node) => node.getKey()));
    counts.splice(from, oldEnd - from, ...units.map((unit) => unit.length));
    changedKeys();
    if (!selection) return;
    $selectLines(
      mapSelection(selection, old, next, firstLine, oldLastLine, region.length),
    );
  };

  /** The selection as lines and offsets of the cache, if in a text block. */
  const $captureLines = (): LineSelection | undefined => {
    const starts = startsOf();
    // Cached between edits: an edit reads the selection before it.
    const firstLineOf = (key: NodeKey) => {
      const unit = unitOfKey(key);
      return unit === undefined ? undefined : starts[unit];
    };
    const anchor = $pointOf("anchor", firstLineOf);
    const focus = $pointOf("focus", firstLineOf);
    return anchor && focus ? { anchor, focus } : undefined;
  };

  /** Selects lines and offsets of the cache (see `$captureLines`). */
  const $selectLines = ({ anchor, focus }: LineSelection) => {
    const all: LexicalNode[] = [];
    for (const child of $getRoot().getChildren()) $lineNodes(child, all);
    const resolve = (point: LinePoint) => {
      const block = all[Math.min(point.line, all.length - 1)];
      return block && $isElementNode(block)
        ? $pointAtOffset(block, point.offset)
        : undefined;
    };
    const a = resolve(anchor);
    const f = resolve(focus);
    if (!a || !f) return;
    const selection = $createRangeSelection();
    selection.anchor.set(a.key, a.offset, a.type);
    selection.focus.set(f.key, f.offset, f.type);
    $setSelection(selection);
  };

  /**
   * The letter a cursor end is right before (`offset` 0), or, at the end of
   * the text, right after (`offset` 1): see `PresenceSelection`.
   */
  const letterOf = (point: LinePoint) => {
    const index = offsetOfLine(point.line) + point.offset;
    const letter = text.letterAt(index);
    if (letter !== undefined) return { key: letter, offset: 0 };
    const last = text.letterAt(index - 1);
    return last === undefined ? undefined : { key: last, offset: 1 };
  };

  /** Where a letter of the text is shown, as a line and an offset in it. */
  const $lineOfLetter = (point: { key: string; offset: number }) => {
    let index = text.indexOfLetter(point.key);
    if (index === undefined) return undefined;
    if (point.offset === 1 && text.letterAt(index) === point.key) index++;
    let start = 0;
    for (let line = 0; line < lines.length; line++) {
      const { length, open } = lines[line]!;
      // Past the end: the end of the last line, before its paragraph letter.
      if (index < start + length || line === lines.length - 1)
        return {
          line,
          offset: Math.min(index - start, open ? length : length - 1),
        };
      start += length;
    }
    return undefined;
  };

  /** The selection as letters (see `letterOf`), if in a text block. */
  const $captureLetters = () => {
    const selection = $captureLines();
    const anchor = selection && letterOf(selection.anchor);
    const focus = selection && letterOf(selection.focus);
    return anchor && focus ? { anchor, focus } : undefined;
  };

  // Before the sync below: an edit's selection is read before the cache
  // changes. The selection goes back to where an undo or redo applies, as
  // letters: paragraphs others added or removed since do not shift it.
  const offHistory = setupHistory(
    editor,
    doc,
    $captureLetters,
    ({ anchor, focus }) => {
      const lineAnchor = $lineOfLetter(anchor);
      const lineFocus = $lineOfLetter(focus);
      if (lineAnchor && lineFocus)
        $selectLines({ anchor: lineAnchor, focus: lineFocus });
    },
  );

  /** DocNode → Lexical: the lines that changed, by whole top-level nodes. */
  const $render = () => {
    const next = linesOf(text.spans());
    const max = Math.min(lines.length, next.length);
    let prefix = 0;
    while (prefix < max && lines[prefix]!.key === next[prefix]!.key) prefix++;
    if (prefix === lines.length && prefix === next.length) return;
    let suffix = 0;
    while (
      suffix < max - prefix &&
      lines[lines.length - 1 - suffix]!.key ===
        next[next.length - 1 - suffix]!.key
    )
      suffix++;
    // Whole top-level nodes, from the one with the line before the change
    // to the one with the line after it.
    const from = lines.length === 0 ? 0 : unitOfLine(Math.max(prefix - 1, 0));
    const last = Math.min(lines.length - suffix, lines.length - 1);
    const oldEnd = lines.length === 0 ? 0 : unitOfLine(last) + 1;
    $rewrite(from, oldEnd, next, false);
  };

  /** Lexical → DocNode: the top-level nodes this update changed. */
  const offUpdate = editor.registerUpdateListener(
    ({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      if (tags.has(COLLABORATION_TAG)) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      const dirty = (key: NodeKey) =>
        dirtyElements.has(key) || dirtyLeaves.has(key);
      const fresh: Line[] = [];
      const freshCounts: number[] = [];
      let newKeys: NodeKey[] = [];
      let from = 0;
      let oldEnd = 0;
      let newEnd = 0;
      let caret: number | undefined;
      let canonical = true;
      editorState.read(() => {
        // Typing changes no top-level node but the ones it types in: their
        // places are known, and the 10,000 keys of a long document need no
        // reading.
        const tops = $dirtyTops(dirtyElements, dirtyLeaves);
        const root = $getRoot();
        let low = Infinity;
        let high = -1;
        if (tops && root.getChildrenSize() === keys.length)
          for (const top of tops) {
            const unit = unitOfKey(top.getKey());
            if (
              unit === undefined ||
              top.getPreviousSibling()?.getKey() !== keys[unit - 1] ||
              top.getNextSibling()?.getKey() !== keys[unit + 1]
            ) {
              low = Infinity;
              break;
            }
            low = Math.min(low, unit);
            high = Math.max(high, unit);
          }
        if (low <= high) {
          newKeys = keys;
          from = low;
          oldEnd = newEnd = high + 1;
        } else {
          newKeys = root.getChildrenKeys();
          let prefix = 0;
          const max = Math.min(keys.length, newKeys.length);
          while (
            prefix < max &&
            keys[prefix] === newKeys[prefix] &&
            !dirty(newKeys[prefix]!)
          )
            prefix++;
          let suffix = 0;
          while (
            suffix < max - prefix &&
            keys[keys.length - 1 - suffix] ===
              newKeys[newKeys.length - 1 - suffix] &&
            !dirty(newKeys[newKeys.length - 1 - suffix]!)
          )
            suffix++;
          from = prefix;
          oldEnd = keys.length - suffix;
          newEnd = newKeys.length - suffix;
        }
        const firstLines = new Map<NodeKey, number>();
        for (let unit = from; unit < newEnd; unit++) {
          firstLines.set(newKeys[unit]!, fresh.length);
          const before = fresh.length;
          const node = $getNodeByKey(newKeys[unit]!)!;
          $readLines(node, fresh);
          freshCounts.push(fresh.length - before);
          if (canonical && !$isPlainBlock(node)) canonical = false;
        }
        const point = $pointOf("focus", (key) => firstLines.get(key));
        if (point) {
          caret = point.offset;
          for (let line = 0; line < point.line; line++)
            caret += fresh[line]!.length;
        }
      });
      const starts = startsOf();
      const firstLine = starts[from]!;
      const lastLine = starts[oldEnd]!;
      const old = lines.slice(firstLine, lastLine);

      const same =
        old.length === fresh.length &&
        old.every((line, index) => line.key === fresh[index]!.key);
      if (!same) {
        writing = true;
        try {
          const write = () =>
            writeRegion(
              text,
              offsetOfLine(firstLine),
              old.flatMap(lineSpans),
              fresh.flatMap(lineSpans),
              caret,
            );
          if (tags.has(SKIP_UNDO_TAG))
            doc.forceCommit(write, { skipUndo: true });
          else {
            write();
            doc.forceCommit();
          }
        } finally {
          writing = false;
        }
        lines.splice(firstLine, lastLine - firstLine, ...fresh);
      }
      if (newKeys !== keys) {
        keys = newKeys;
        changedKeys();
      }
      const replaced = counts.splice(from, oldEnd - from, ...freshCounts);
      if (
        replaced.length !== freshCounts.length ||
        replaced.some((count, index) => count !== freshCounts[index])
      )
        cachedStarts = undefined;
      if (newEnd <= from || canonical) return;
      // Every replica shows the tree the lines build: Lexical may have built
      // these nodes another way (two lists side by side, a split text node).
      const touched = newKeys.slice(from, newEnd);
      schedule(() => {
        const first = keys.indexOf(touched[0]!);
        const last = keys.indexOf(touched.at(-1)!);
        if (first === -1 || last < first) return;
        $rewrite(first, last + 1, lines, true);
      });
    },
  );

  const offChange = doc.onChange(() => {
    if (!writing) schedule($render);
  });

  // The document wins: the editor starts with its lines.
  schedule(() => {
    $resync();
    $render();
  });

  /**
   * Cursor ends as letters (see `letterOf`), like Yjs relative positions:
   * edits of others around them leave them in place.
   */
  const points: PresencePoints = {
    $local: $captureLetters,
    $remote: (point) => {
      const at = $lineOfLetter(point);
      if (!at) return undefined;
      const unit = unitOfLine(at.line);
      const top = $getNodeByKey(keys[unit]!);
      const nodes: LexicalNode[] = [];
      if (top) $lineNodes(top, nodes);
      const block = nodes[at.line - startsOf()[unit]!];
      // Transforms changed the top-level nodes: the cache reads them next.
      if (!block) return undefined;
      if ($isElementNode(block)) return $pointAtOffset(block, at.offset);
      // A line that is not text (an image): right before it.
      return {
        key: block.getParentOrThrow().getKey(),
        offset: block.getIndexWithinParent(),
        type: "element",
      };
    },
  };
  // After the sync above: the selection is read once the edit is written.
  const offPresence = bindPresence(editor, points, options);

  return () => {
    offPresence?.();
    offUpdate();
    offChange();
    offHistory();
  };
}

/**
 * The top-level nodes of the dirty nodes of an update, or undefined when one
 * of them is gone or is the root itself changing (nodes added or removed).
 */
function $dirtyTops(
  dirtyElements: Map<NodeKey, boolean>,
  dirtyLeaves: Set<NodeKey>,
): Set<LexicalNode> | undefined {
  const tops = new Set<LexicalNode>();
  const add = (key: NodeKey) => {
    if (key === "root") return true;
    const node = $getNodeByKey(key);
    const top =
      node?.getTopLevelElement() ??
      (node?.getParent()?.getKey() === "root" ? node : null);
    if (!top) return false;
    tops.add(top);
    return true;
  };
  for (const [key] of dirtyElements) if (!add(key)) return undefined;
  for (const key of dirtyLeaves) if (!add(key)) return undefined;
  return tops;
}

/**
 * A paragraph or heading of plain text nodes and line breaks: Lexical keeps
 * it as the lines build it (it merges text nodes of the same format itself).
 */
function $isPlainBlock(node: LexicalNode): boolean {
  if (!$isTextBlock(node)) return false;
  for (const child of node.getChildren()) {
    if ($isLineBreakNode(child)) continue;
    if (!$isTextNode(child) || child.getMode() !== "normal") return false;
    const type = child.getType();
    if (type !== "text" && type !== "tab") return false;
  }
  return true;
}

/**
 * The selection of the `old` lines in the `next` ones, which replaced the
 * lines `[first, oldLast)` with `newCount` lines. A point in them moves with
 * the text around it, as if the region's text changed by one replacement
 * (see `mapOffset`): a remote edit next to the selection or inside it moves
 * it with the letters.
 */
function mapSelection(
  { anchor, focus }: LineSelection,
  old: Line[],
  next: Line[],
  first: number,
  oldLast: number,
  newCount: number,
) {
  const replacement = replacementOf(
    regionText(old, first, oldLast),
    regionText(next, first, first + newCount),
  );
  // Where a point is in the region's text: before or after it, it is before
  // or after the replacement too.
  const at = (point: LinePoint) =>
    point.line < first
      ? -1
      : point.line >= oldLast
        ? Infinity
        : offsetIn(old, first, point);
  const start = Math.min(at(anchor), at(focus));
  const end = Math.max(at(anchor), at(focus));
  const move = (point: LinePoint, role: "anchor" | "focus") => {
    if (point.line < first) return point;
    if (point.line >= oldLast)
      return {
        line: point.line - oldLast + first + newCount,
        offset: point.offset,
      };
    const offset = mapOffset(at(point), role, start, end, replacement);
    return pointIn(next, first, offset);
  };
  return { anchor: move(anchor, "anchor"), focus: move(focus, "focus") };
}

/** The text of the lines `[from, to)`, their paragraph letters included. */
function regionText(lines: Line[], from: number, to: number) {
  let text = "";
  for (let line = from; line < to; line++)
    for (const span of lineSpans(lines[line]!)) text += span.text;
  return text;
}

/** Where a point is in the text of the lines from `first` on. */
function offsetIn(lines: Line[], first: number, point: LinePoint) {
  let offset = point.offset;
  for (let line = first; line < point.line; line++)
    offset += lines[line]!.length;
  return offset;
}

/**
 * The point at `offset` of the text of the lines from `first` on; past the
 * end, the end of the last line, before its paragraph letter.
 */
function pointIn(lines: Line[], first: number, offset: number) {
  let start = 0;
  for (let line = first; line < lines.length; line++) {
    const { length, open } = lines[line]!;
    if (offset < start + length || line === lines.length - 1)
      return {
        line,
        offset: Math.min(offset - start, open ? length : length - 1),
      };
    start += length;
  }
  return { line: first, offset: 0 };
}

/**
 * The one replacement that turns `before` into `after`, what they do not
 * share: the text from `start` to `oldEnd` became the text from `start` to
 * `newEnd`.
 */
function replacementOf(before: string, after: string) {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return { start, oldEnd, newEnd };
}

/**
 * Where an end of the selection `[start, end]` goes after `replacement`.
 * Before it, it stays; after it, it moves with the text. At its start, it
 * stays before the new text; at its end, after it. Inside it, the end stays
 * on the side of the selection that is left: the new text joins the
 * selection when the replacement took its first or last part. A replacement
 * that takes the whole selection and more leaves a cursor at its start.
 */
function mapOffset(
  offset: number,
  role: "anchor" | "focus",
  start: number,
  end: number,
  replacement: ReturnType<typeof replacementOf>,
) {
  if (replacement.start < start && replacement.oldEnd > end)
    return replacement.start;
  if (offset < replacement.start) return offset;
  if (offset > replacement.oldEnd)
    return offset + replacement.newEnd - replacement.oldEnd;
  if (offset === replacement.start) return replacement.start;
  if (offset === replacement.oldEnd) return replacement.newEnd;
  if (role === "anchor")
    return replacement.start < start ? replacement.newEnd : replacement.start;
  return replacement.oldEnd > end ? replacement.start : replacement.newEnd;
}

/**
 * Writes the text of a region from `old` to `next` spans, at `offset` of the
 * container: one insert and one delete at most, then the state of the
 * letters that kept their place and changed it.
 */
export function writeRegion(
  text: TextHandle,
  offset: number,
  old: TextSpan[],
  next: TextSpan[],
  caret: number | undefined,
) {
  const current = old.map((span) => span.text).join("");
  const target = next.map((span) => span.text).join("");
  const max = Math.min(current.length, target.length);
  let prefix = 0;
  while (
    prefix < max &&
    current.charCodeAt(prefix) === target.charCodeAt(prefix)
  )
    prefix++;
  if (prefix > 0 && isHigh(current.charCodeAt(prefix - 1))) prefix--;
  const commonSuffix = (limit: number) => {
    let suffix = 0;
    while (
      suffix < limit &&
      current.charCodeAt(current.length - 1 - suffix) ===
        target.charCodeAt(target.length - 1 - suffix)
    )
      suffix++;
    return suffix;
  };
  let suffix = commonSuffix(max - prefix);
  if (suffix > 0 && isLow(target.charCodeAt(target.length - suffix))) suffix--;
  // A pure insert or delete in repeated text: the caret picks the place.
  if (caret !== undefined && prefix + suffix === max) {
    const length = Math.abs(target.length - current.length);
    const lowest = max - commonSuffix(max);
    const wanted = target.length > current.length ? caret - length : caret;
    const at = Math.min(prefix, Math.max(lowest, wanted));
    const longer = target.length > current.length ? target : current;
    if (!splits(current, at) && !splits(longer, at + length)) {
      prefix = at;
      suffix = max - at;
    }
  }
  const removed = current.length - prefix - suffix;
  const insertedEnd = target.length - suffix;
  let at = prefix;
  for (const piece of slices(next, prefix, insertedEnd)) {
    // The exact state: `{}` is none, not what the letters would inherit.
    text.insert(offset + at, piece.text, piece.attrs ?? {});
    at += piece.text.length;
  }
  if (removed > 0) text.delete(offset + insertedEnd, removed);
  // The state of the letters kept: those before and after the edit.
  const kept: TextSpan[] = [
    ...slices(old, 0, prefix).map(asSpan),
    ...slices(next, prefix, insertedEnd).map(asSpan),
    ...slices(old, current.length - suffix, current.length).map(asSpan),
  ];
  formatDiff(text, offset, kept, next);
}

const asSpan = (piece: {
  text: string;
  attrs: Record<string, Json> | undefined;
}) => ({ text: piece.text, attrs: piece.attrs ?? {} });

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const splits = (text: string, index: number) =>
  isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index));

function slices(spans: TextSpan[], from: number, to: number) {
  const out: { text: string; attrs: Record<string, Json> | undefined }[] = [];
  let cursor = 0;
  for (const span of spans) {
    const end = cursor + span.text.length;
    const start = Math.max(cursor, from);
    const stop = Math.min(end, to);
    if (stop > start) {
      const empty = Object.keys(span.attrs).length === 0;
      out.push({
        text: span.text.slice(start - cursor, stop - cursor),
        attrs: empty ? undefined : span.attrs,
      });
    }
    cursor = end;
  }
  return out;
}

/** `setLetterState` where `current` and `target` (same text) differ, by ranges. */
function formatDiff(
  text: TextHandle,
  offset: number,
  current: TextSpan[],
  target: TextSpan[],
) {
  const stops = new Set<number>([0]);
  const collect = (spans: TextSpan[]) => {
    let cursor = 0;
    for (const span of spans) {
      cursor += span.text.length;
      stops.add(cursor);
    }
  };
  collect(current);
  collect(target);
  const positions = [...stops].sort((a, b) => a - b);
  const walker = (spans: TextSpan[]) => {
    let index = 0;
    let end = spans[0]?.text.length ?? 0;
    return (at: number) => {
      while (index < spans.length && at >= end) {
        index++;
        end += spans[index]?.text.length ?? 0;
      }
      return spans[index]?.attrs ?? {};
    };
  };
  const was = walker(current);
  const wants = walker(target);
  const pending = new Map<string, { from: number; to: number; value: Json }>();
  const flush = (key: string) => {
    const range = pending.get(key);
    if (!range) return;
    pending.delete(key);
    text.format(offset + range.from, offset + range.to, key, range.value);
  };
  for (let i = 0; i < positions.length - 1; i++) {
    const from = positions[i]!;
    const to = positions[i + 1]!;
    const before = was(from);
    const after = wants(from);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const value = after[key] ?? null;
      if (JSON.stringify(before[key] ?? null) === JSON.stringify(value)) {
        flush(key);
        continue;
      }
      const open = pending.get(key);
      if (
        open?.to === from &&
        JSON.stringify(open.value) === JSON.stringify(value)
      )
        open.to = to;
      else {
        flush(key);
        pending.set(key, { from, to, value });
      }
    }
    for (const key of [...pending.keys()]) if (!keys.has(key)) flush(key);
  }
  for (const key of [...pending.keys()]) flush(key);
}

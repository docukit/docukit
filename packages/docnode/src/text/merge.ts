import type { EditOperation, OrderedOperation } from "../operations.js";
import type { Json } from "../types.js";

const listOf = (value: Json | undefined): readonly Json[] | undefined =>
  Array.isArray(value) ? value : undefined;

/** The letters of an insert's content: `text` or `[text, ...state]`. */
const lettersOf = (content: Json | undefined) =>
  listOf(content)?.[0] ?? content;

/** The first state an insert's content gives its letters, as a string. */
const stateOf = (content: Json | undefined) => {
  const list = listOf(content);
  return list ? JSON.stringify(list.slice(1)) : "";
};

/** A right origin without the sign that also makes an insert its left child. */
const unsigned = (right: unknown) =>
  typeof right === "number" ? Math.abs(right) : (right ?? 0);

function fuse(
  previous: OrderedOperation | undefined,
  next: OrderedOperation,
): EditOperation | undefined {
  if (previous?.[0] !== 3 || next[0] !== 3) return undefined;
  const [, session, counter, content, right] = previous;
  const [, nextSession, nextCounter, nextContent, nextRight] = next;
  // Letters with the same first state fuse too: `[text, ...state]`.
  const text = lettersOf(content);
  const nextText = lettersOf(nextContent);
  if (
    typeof session !== "string" ||
    typeof text !== "string" ||
    typeof nextText !== "string" ||
    stateOf(content) !== stateOf(nextContent) ||
    typeof counter !== "number" ||
    nextSession !== session ||
    nextCounter !== counter + text.length ||
    next.length > 5 ||
    // A negative right origin also makes `next` a left child of it.
    (typeof nextRight === "number" && nextRight < 0) ||
    // In Base, at a node's start (`^node`, `#hash`): not after `previous`.
    (typeof nextRight === "string" && /^[#^]/.test(nextRight)) ||
    unsigned(right) !== unsigned(nextRight)
  )
    return undefined;
  const fused: EditOperation = [...previous];
  const list = listOf(content);
  fused[3] = list ? [text + nextText, ...list.slice(1)] : text + nextText;
  return fused;
}

/**
 * Fuses every text insertion typed right after the previous one. Applying the
 * result is the same as applying the operations one by one, and a replica that
 * already saw a prefix of a fused run skips it.
 */
export function fuseTextInserts(
  operations: OrderedOperation[],
): OrderedOperation[] {
  const out: OrderedOperation[] = [];
  for (const operation of operations) {
    const fused = fuse(out.at(-1), operation);
    if (fused) out[out.length - 1] = fused;
    else out.push(operation);
  }
  return out;
}

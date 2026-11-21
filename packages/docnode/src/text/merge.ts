import type { EditOperation, OrderedOperation } from "../operations.js";

/** A right origin without the sign that also makes an insert its left child. */
const unsigned = (right: unknown) =>
  typeof right === "number" ? Math.abs(right) : (right ?? 0);

function fuse(
  previous: OrderedOperation | undefined,
  next: OrderedOperation,
): EditOperation | undefined {
  if (previous?.[0] !== 3 || next[0] !== 3) return undefined;
  const [, session, counter, content, right] = previous;
  const [, nextSession, nextCounter, text, nextRight] = next;
  if (
    typeof session !== "string" ||
    typeof content !== "string" ||
    typeof text !== "string" ||
    typeof counter !== "number" ||
    nextSession !== session ||
    nextCounter !== counter + content.length ||
    next.length > 5 ||
    // A negative right origin also makes `next` a left child of it.
    (typeof nextRight === "number" && nextRight < 0) ||
    // In Base, at a node's start (`^node`, `#hash`): not after `previous`.
    (typeof nextRight === "string" && /^[#^]/.test(nextRight)) ||
    unsigned(right) !== unsigned(nextRight)
  )
    return undefined;
  const fused: EditOperation = [...previous];
  fused[3] = content + text;
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

import type { Operations } from "@docukit/docnode";

const DIGITS =
  "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

const clockOf = (written: string) =>
  [...written].reduce((clock, digit) => clock * 64 + DIGITS.indexOf(digit), 0);

/** The sessions a batch's head names, the first one by itself, and its counter. */
function headOf(batch: Operations) {
  const head = batch[0];
  const [named = "", ...others] = typeof head === "string" ? [head] : head;
  const dot = named.lastIndexOf(".");
  return {
    sessions: [dot === -1 ? named : named.slice(0, dot), ...others],
    counter: dot === -1 ? 0 : clockOf(named.slice(dot + 1)),
  };
}

/**
 * How an engine row of `batch` writes the node `id` (see `wire.ts`): a node
 * of the head's session as its distance from the head's counter when that is
 * not longer, else `session.clock` as `index.clock`.
 */
export function written(batch: Operations, id: string): string | number {
  const { sessions, counter } = headOf(batch);
  const dot = id.lastIndexOf(".");
  const index = sessions.indexOf(id.slice(0, dot));
  const clock = clockOf(id.slice(dot + 1));
  const distance = clock >= counter ? clock - counter + 1 : clock - counter;
  if (index === 0 && `${Math.abs(distance)}`.length < id.length - dot)
    return distance;
  return index === 0 ? id.slice(dot) : `${index}${id.slice(dot)}`;
}

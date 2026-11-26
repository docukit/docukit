import type { Json, JsonDoc } from "../types.js";

/**
 * A document in the legacy format: each node is `[id, type, state,
 * children?]`, with each state value as a string of JSON.
 */
export type LegacyJsonDoc = [
  id: string,
  type: string,
  state: Record<string, string>,
  children?: LegacyJsonDoc[],
];

/**
 * Converts a document in the legacy format (`LegacyJsonDoc`) so that
 * `Doc.fromJSON` can load it.
 *
 * @example
 * ```ts
 * const doc = Doc.fromJSON(config, fromLegacyJson(stored));
 * ```
 */
export function fromLegacyJson(legacy: LegacyJsonDoc): JsonDoc {
  const [id, type, legacyState, legacyChildren] = legacy;
  const state: Record<string, Json> = {};
  for (const key in legacyState) state[key] = parse(legacyState[key]!);
  if (!legacyChildren?.length) return [id, type, state];
  const [first, ...rest] = legacyChildren.map(fromLegacyJson);
  return [id, type, state, [first!, ...rest]];
}

const parse = (text: string): Json => JSON.parse(text) as Json;

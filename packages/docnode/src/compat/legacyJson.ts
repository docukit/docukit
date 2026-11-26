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
  if (!legacyChildren?.length) return [id, type, parseState(legacyState)];
  const types: string[] = [];
  const typeIndexes = new Map<string, number>();
  const typeColumn: number[] = [];
  const children: number[] = [legacyChildren.length];
  const states: Record<string, Json>[] = [];
  const ids: string[] = [];
  const walk = (nodes: LegacyJsonDoc[]) => {
    for (const [nodeId, nodeType, nodeState, nodeChildren] of nodes) {
      ids.push(nodeId);
      let index = typeIndexes.get(nodeType);
      if (index === undefined) {
        index = types.push(nodeType) - 1;
        typeIndexes.set(nodeType, index);
      }
      typeColumn.push(index);
      states.push(parseState(nodeState));
      children.push(nodeChildren?.length ?? 0);
      if (nodeChildren) walk(nodeChildren);
    }
  };
  walk(legacyChildren);
  const json: JsonDoc = [
    id,
    type,
    parseState(legacyState),
    types,
    typeColumn,
    children,
    states,
    [],
    ids,
  ];
  return json;
}

function parseState(legacyState: Record<string, string>) {
  const state: Record<string, Json> = {};
  for (const key in legacyState)
    state[key] = JSON.parse(legacyState[key]!) as Json;
  return state;
}

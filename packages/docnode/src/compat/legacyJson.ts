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
  const types: [name: string, ...keys: string[]][] = [];
  const typeIndexes = new Map<string, number>();
  const typeColumn: number[] = [];
  const children: number[] = [legacyChildren.length];
  const states: number[] = [];
  const values: Json[] = [];
  const ids: string[] = [];
  // The keys each node has, as indexes in its type's keys: its masks are
  // written once every type has all its keys.
  const nodeKeys: number[][] = [];
  const walk = (nodes: LegacyJsonDoc[]) => {
    for (const [nodeId, nodeType, nodeState, nodeChildren] of nodes) {
      ids.push(nodeId);
      let index = typeIndexes.get(nodeType);
      if (index === undefined) {
        index = types.length;
        types.push([nodeType]);
        typeIndexes.set(nodeType, index);
      }
      typeColumn.push(index);
      // The keys of a type are its keys in the order they first appear.
      const keys = types[index]!;
      const present: number[] = [];
      for (const key in nodeState) {
        let k = keys.indexOf(key, 1);
        if (k < 0) k = keys.push(key) - 1;
        present.push(k - 1);
      }
      present.sort((a, b) => a - b);
      for (const k of present) values.push(parse(nodeState[keys[k + 1]!]!));
      nodeKeys.push(present);
      children.push(nodeChildren?.length ?? 0);
      if (nodeChildren) walk(nodeChildren);
    }
  };
  walk(legacyChildren);
  for (let n = 0; n < nodeKeys.length; n++) {
    const chunks = Math.max(
      1,
      Math.ceil((types[typeColumn[n]!]!.length - 1) / 30),
    );
    const masks: number[] = new Array<number>(chunks).fill(0);
    for (const k of nodeKeys[n]!) masks[Math.floor(k / 30)]! += 2 ** (k % 30);
    states.push(...masks);
  }
  const json: JsonDoc = [
    id,
    type,
    state,
    types,
    typeColumn,
    children,
    states,
    values,
    [],
    ids,
  ];
  return json;
}

const parse = (text: string): Json => JSON.parse(text) as Json;

import type { Doc, DocNode } from "./main.js";
import type {
  InternalStateDefinition,
  Json,
  JsonDoc,
  JsonDocWithoutText,
  ResolvedNodeDefinition,
} from "./types.js";
import {
  ColumnReader,
  ColumnWriter,
  frontCode,
  frontDecode,
  joinColumns,
  readSessions,
  SessionTable,
  splitColumns,
} from "./columns.js";
import { numberToBase64 } from "./idGenerator.js";
import { jsonCopy, jsonEqual } from "./utils.js";

/** The stored format `Doc.toJSON` writes (see `JsonDoc`). */
export const FORMAT = 14;

/** The stored format before text, which is still read (see `JsonDocWithoutText`). */
const WITHOUT_TEXT = 13;

/**
 * The columns of a stored document before those of its text (see
 * `JsonDoc`): how much each session shares with the one before, and the
 * tree.
 */
const COLUMN = {
  SHARED: 0,
  SESSION: 1,
  CLOCK: 2,
  TYPE: 3,
  CHILDREN: 4,
  STATE: 5,
  KEY: 6,
  NUMBER: 7,
};
const COLUMNS = 8;

/** A value that goes in the column of numbers: a whole one, not negative. */
const inColumn = (value: Json): value is number =>
  typeof value === "number" && value >= 0 && Number.isSafeInteger(value);

/**
 * The value of `key` in `state` as JSON, or `undefined` when it is the
 * default one, which is not stored.
 */
function storedValue(
  node: DocNode,
  definition: ResolvedNodeDefinition,
  state: Record<string, unknown>,
  key: string,
): Json | undefined {
  const stateDefinition = definition.state[key]!;
  // What a JSON round trip gives: a value with its own `toJSON` (a date),
  // or an object that is the state itself, would not be.
  const raw = stateDefinition.toJSON
    ? stateDefinition.toJSON(state[key])
    : state[key];
  // Most values are strings and numbers, which need no copy.
  const json = typeof raw === "string" ? raw : jsonCopy(raw);
  if (json === undefined)
    throw new Error(
      `The JSON serialization for state ${key} on a node of type ${node.type} is undefined.`,
    );
  return jsonEqual(json, definition.defaultJson[key]!) ? undefined : json;
}

/** The root state that holds the document's text (see `docState`). */
function textDefinition(
  doc: Doc,
  type: string,
  key: string,
): InternalStateDefinition {
  return doc["_resolvedNodeDefs"].get(type)!.state[key]!;
}

/**
 * How a node's session is written: 0 when it is that of the node before
 * (session 0 for the first node), 1 when it is the one after the highest so
 * far, else its index plus 2. Nodes in a row mostly share a session, and the
 * table gets sessions as nodes come: a node of each of many sessions (each
 * user inserting one) is written 1, 1, 1… and not 0, 1, 2…
 */
const sessionCode = (index: number, before: number, highest: number) =>
  index === before ? 0 : index === highest + 1 ? 1 : index + 2;

const countChildren = (node: DocNode) => {
  let count = 0;
  for (let child = node.first; child; child = child.next) count++;
  return count;
};

/** `doc` as it is stored (see `JsonDoc`), without its id. */
export function writeJsonDoc(doc: Doc): JsonDoc {
  const root = doc.root;
  const definitions = doc["_resolvedNodeDefs"];
  const textKey = doc["_editStateKey"];
  const rootValues: Record<string, unknown> = root["_state"];
  const rootState: Record<string, Json> = {};
  const rootDefinition = definitions.get(root.type)!;
  // In the order of the definition, the same in every replica.
  for (const key in rootDefinition.state) {
    // The text goes apart.
    if (key === textKey || !(key in rootValues)) continue;
    const value = storedValue(root, rootDefinition, rootValues, key);
    if (value !== undefined) rootState[key] = value;
  }
  const json: JsonDoc = [FORMAT, root.type, rootState];
  const sessions = new SessionTable();
  const textColumns: { encode(): string }[] = [];
  const text =
    textKey !== undefined && textKey in rootValues
      ? textDefinition(doc, root.type, textKey).toStored!(
          rootValues[textKey],
          sessions,
          textColumns,
        )
      : 0;
  if (!root.first && text === 0) return json;
  const size = doc["_nodeMap"].size;
  const sessionColumn = new ColumnWriter(size);
  const clockColumn = new ColumnWriter(size);
  const typeColumn = new ColumnWriter(size);
  const childrenColumn = new ColumnWriter(size);
  const stateColumn = new ColumnWriter(size);
  const keyColumn = new ColumnWriter(size);
  const numberColumn = new ColumnWriter(size, true);
  /** Each type: its index in `types`, its definition and its state keys. */
  const types = new Map<
    string,
    { index: number; definition: ResolvedNodeDefinition; keys: string[] }
  >();
  // No node has the type `undefined`: `last` is first replaced.
  let lastType: string | undefined;
  let last = { index: -1, definition: rootDefinition, keys: [""] };
  const typeOf = (name: string) => {
    // Nodes in a row are often of one type.
    if (name === lastType) return last;
    let type = types.get(name);
    if (type === undefined) {
      const definition = definitions.get(name)!;
      // In the order of the definition, the same in every replica.
      const stateKeys = Object.keys(definition.state);
      type = { index: types.size, definition, keys: stateKeys };
      types.set(name, type);
    }
    lastType = name;
    return (last = type);
  };
  const keys = new Map<string, number>();
  const values: Json[] = [];
  /** The last clock of each session, which the next one is written after. */
  const clocks: number[] = [];
  // The session of the node before, and the highest one so far (see
  // `sessionCode`).
  let before = 0;
  let highest = -1;
  // A session's first clock is mostly 0 (its id alone), written as 0.
  childrenColumn.push(countChildren(root));
  let node = root.first;
  while (node) {
    const index = sessions.node(node.id);
    const clock = sessions.clock;
    sessionColumn.push(sessionCode(index, before, highest));
    before = index;
    if (index > highest) highest = index;
    clockColumn.pushSigned(clock - (clocks[index] ?? -1) - 1);
    clocks[index] = clock;
    const type = typeOf(node.type);
    typeColumn.push(type.index);
    childrenColumn.push(countChildren(node));
    let count = 0;
    const state: Record<string, unknown> = node["_state"];
    const definition = type.definition;
    for (const key of type.keys) {
      if (!(key in state)) continue;
      const value = storedValue(node, definition, state, key);
      if (value === undefined) continue;
      let index = keys.get(key);
      if (index === undefined) keys.set(key, (index = keys.size));
      // Its key says where it is: in the column of numbers or in `values`.
      if (inColumn(value)) {
        keyColumn.push(index * 2 + 1);
        numberColumn.push(value);
      } else {
        keyColumn.push(index * 2);
        values.push(value);
      }
      count++;
    }
    stateColumn.push(count);
    // The next node in preorder.
    let next = node.first;
    for (let up: DocNode = node; !next && up !== root; up = up.parent!)
      next = up.next;
    node = next;
  }
  // Sessions mostly share their start with the one before, the first with
  // the document's id.
  const sharedColumn = new ColumnWriter();
  const table = frontCode(sessions.table, root.id, sharedColumn);
  // The text before the columns: gzip compresses the letters better when
  // they come first. Only `values` can be empty at the end.
  json.push(
    table,
    [...types.keys()],
    [...keys.keys()],
    text,
    // In the order of `COLUMN`, then the text's.
    joinColumns([
      sharedColumn,
      sessionColumn,
      clockColumn,
      typeColumn,
      childrenColumn,
      stateColumn,
      keyColumn,
      numberColumn,
      ...textColumns,
    ]),
  );
  if (values.length > 0) json.push(values);
  return json;
}

/**
 * A stored document of format 13, from before text, in today's format: its
 * columns go after a `0` for no text. Any other is returned as it is.
 */
export function withText(json: JsonDoc | JsonDocWithoutText): JsonDoc {
  if (json[0] !== WITHOUT_TEXT) return json;
  const [, type, state, sessions = [], types = [], keys = [], ...rest] = json;
  return [FORMAT, type, state, sessions, types, keys, 0, ...rest];
}

/**
 * The sessions of the table of a stored `json` (see `JsonDoc`), `id` the
 * document's: what `readJsonDoc` reads, for a CRDT engine.
 */
export const storedSessions = (json: JsonDoc, id: string): string[] =>
  readSessions(
    frontDecode(
      json[3] ?? [],
      id,
      new ColumnReader(splitColumns(json[7] ?? "", 1)[COLUMN.SHARED]!),
    ),
  );

/**
 * `json` with what a CRDT engine stores besides the tree (see
 * `DocConfig.crdt`), and every element before it.
 */
export function withCrdt(json: JsonDoc, crdt: Json): JsonDoc {
  json[3] ??= [];
  json[4] ??= [];
  json[5] ??= [];
  json[6] ??= 0;
  json[7] ??= "";
  json[8] ??= [];
  json[9] = crdt;
  return json;
}

/**
 * Builds the nodes of a stored `json` in `doc`, in place of its root. The
 * document's id is the one `Doc.fromJSON` gave it.
 */
export function readJsonDoc(doc: Doc, json: JsonDoc): void {
  const [
    ,
    type,
    rootState,
    table = [],
    types = [],
    keys = [],
    text,
    tree = "",
    values = [],
  ] = json;
  // A number: what another version stored can have another one.
  const format: number = json[0];
  if (format !== FORMAT)
    throw new Error(
      `The stored document has format ${format}, but this version reads formats ${WITHOUT_TEXT} and ${FORMAT}.`,
    );
  const id = doc.root.id;
  const rootDefinition = doc["_storedDefinition"](type);
  const state: Record<string, unknown> = {};
  for (const key in rootState)
    state[key] = doc["_storedValue"](rootDefinition, key, rootState[key]!);
  const columns = splitColumns(tree);
  const reader = (field: number) => new ColumnReader(columns[field] ?? "");
  const sessions = readSessions(frontDecode(table, id, reader(COLUMN.SHARED)));
  if (text) {
    const textKey = doc["_editStateKey"];
    if (textKey === undefined)
      throw new Error(
        "The stored document has text, but no node type defines it (see `defineText`).",
      );
    state[textKey] = textDefinition(doc, type, textKey).fromStored!(
      text,
      columns.slice(COLUMNS),
      sessions,
    );
  }
  const root = doc["_storedNode"](id, type, state);
  doc["_setStoredRoot"](root);
  const sessionColumn = reader(COLUMN.SESSION);
  const clockColumn = reader(COLUMN.CLOCK);
  const typeColumn = reader(COLUMN.TYPE);
  const childrenColumn = reader(COLUMN.CHILDREN);
  const stateColumn = reader(COLUMN.STATE);
  const keyColumn = reader(COLUMN.KEY);
  const numberColumn = reader(COLUMN.NUMBER);
  const definitions = types.map((type) => doc["_storedDefinition"](type));
  const clocks = new Float64Array(sessions.length).fill(-1);
  let before = 0;
  let highest = -1;
  const prefixes = sessions.map((session) => `${session}.`);
  let value = 0;
  const attach = (parent: DocNode) => {
    let prev: DocNode | undefined;
    for (let left = childrenColumn.next(); left > 0; left--) {
      const code = sessionColumn.next();
      const session = code === 0 ? before : code === 1 ? highest + 1 : code - 2;
      before = session;
      if (session > highest) highest = session;
      const clock = clocks[session]! + 1 + clockColumn.nextSigned();
      clocks[session] = clock;
      const index = typeColumn.next();
      const definition = definitions[index]!;
      const state: Record<string, unknown> = {};
      for (let count = stateColumn.next(); count > 0; count--) {
        const code = keyColumn.next();
        const key = keys[code >> 1]!;
        state[key] = doc["_storedValue"](
          definition,
          key,
          code & 1 ? numberColumn.next() : values[value++]!,
        );
      }
      const id =
        clock === 0
          ? sessions[session]!
          : prefixes[session]! + numberToBase64(clock - 1);
      const node = doc["_storedNode"](id, types[index]!, state);
      doc["_linkStored"](parent, prev, node);
      prev = node;
      attach(node);
    }
    parent["_set"]("last", prev);
  };
  attach(root);
}

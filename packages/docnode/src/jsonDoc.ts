import type { Doc, DocNode } from "./main.js";
import type {
  InternalStateDefinition,
  Json,
  JsonDoc,
  ResolvedNodeDefinition,
  StoredRest,
  StoredState,
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
import { isRecord } from "./text/common.js";
import { jsonCopy, jsonEqual } from "./utils.js";

/**
 * The columns of a stored document's tree (see `JsonDoc`), after the one of
 * how much each session shares with the one before and those of its text.
 */
const COLUMN_SESSION = 0;
const COLUMN_CLOCK = 1;
const COLUMN_TYPE = 2;
const COLUMN_CHILDREN = 3;
const COLUMN_STATE = 4;
const COLUMN_KEY = 5;
const COLUMN_NUMBER = 6;

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

/**
 * A stored document of its sessions, its type and its elements (see
 * `elementsOf`): without its state when it is `0`, and without the empty
 * elements, `0`, at its end.
 */
export function storedDoc(
  table: string[],
  type: string,
  [state, ...rest]: [StoredState | 0, ...StoredRest],
): JsonDoc {
  const json: JsonDoc = state
    ? [table, type, state, ...rest]
    : [table, type, ...rest];
  while (json.at(-1) === 0) json.pop();
  return json;
}

const countChildren = (node: DocNode) => {
  let count = 0;
  for (let child = node.first; child; child = child.next) count++;
  return count;
};

/** The root state that holds the document's text (see `docState`). */
function textDefinition(
  doc: Doc,
  type: string,
  key: string,
): InternalStateDefinition {
  return doc["_resolvedNodeDefs"].get(type)!.state[key]!;
}

/**
 * The tree of `doc` in `columns` (in the order of `COLUMN_*`), its sessions
 * in `sessions`, the names of its types and keys in `names` and its values
 * in `values`. A function of its own, called only with a tree: a save runs
 * once, mostly cold, and the code of a function never called is not
 * compiled. Top-level, with what it uses as its own variables: a closure's
 * would be context slots, slower in a cold run.
 */
function writeTree(
  doc: Doc,
  sessions: SessionTable,
  columns: ColumnWriter[],
  names: Map<string, number>,
  values: Json[],
): void {
  const root = doc.root;
  const definitions = doc["_resolvedNodeDefs"];
  const rootDefinition = definitions.get(root.type)!;
  const size = doc["_nodeMap"].size;
  const sessionColumn = new ColumnWriter(size);
  const clockColumn = new ColumnWriter(size);
  const typeColumn = new ColumnWriter(size);
  const childrenColumn = new ColumnWriter(size);
  const stateColumn = new ColumnWriter(size);
  const keyColumn = new ColumnWriter(size);
  const numberColumn = new ColumnWriter(size, true);
  const nameIndex = (name: string) => {
    let index = names.get(name);
    if (index === undefined) names.set(name, (index = names.size));
    return index;
  };
  /** Each type: its index in `names`, its definition and its state keys. */
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
      type = { index: nameIndex(name), definition, keys: stateKeys };
      types.set(name, type);
    }
    lastType = name;
    return (last = type);
  };
  /** The last clock of each session, which the next one is written after. */
  const clocks: number[] = [];
  // The session of the node before, and the highest one so far.
  let before = 0;
  let highest = -1;
  // A session's first clock is mostly 0 (its id alone), written as 0.
  childrenColumn.push(countChildren(root));
  let node = root.first;
  while (node) {
    const index = sessions.node(node.id);
    const clock = sessions.clock;
    // How its session is written: 0 when it is that of the node before
    // (session 0 for the first node), 1 when it is the one after the highest
    // so far, else its index plus 2. Nodes in a row mostly share a session,
    // and the table gets sessions as nodes come: a node of each of many
    // sessions (each user inserting one) is written 1, 1, 1… and not 0, 1, 2…
    sessionColumn.push(
      index === before ? 0 : index === highest + 1 ? 1 : index + 2,
    );
    before = index;
    if (index > highest) highest = index;
    clockColumn.pushSigned(clock - (clocks[index] ?? -1) - 1);
    clocks[index] = clock;
    const type = typeOf(node.type);
    typeColumn.push(type.index);
    childrenColumn.push(node.first ? countChildren(node) : 0);
    let count = 0;
    const state: Record<string, unknown> = node["_state"];
    const definition = type.definition;
    const keys = type.keys;
    // A save runs mostly cold, where a `for…of` makes an iterator per node.
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let at = 0; at < keys.length; at++) {
      const key = keys[at]!;
      if (!(key in state)) continue;
      const value = storedValue(node, definition, state, key);
      if (value === undefined) continue;
      const index = nameIndex(key);
      // Its key says where it is: in the column of numbers (a whole one,
      // not negative) or in `values`.
      if (
        typeof value === "number" &&
        value >= 0 &&
        Number.isSafeInteger(value)
      ) {
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
  columns.push(
    sessionColumn,
    clockColumn,
    typeColumn,
    childrenColumn,
    stateColumn,
    keyColumn,
    numberColumn,
  );
}

/** `doc` as it is stored (see `JsonDoc`), without its id. */
export function writeJsonDoc(doc: Doc): JsonDoc {
  const root = doc.root;
  const definitions = doc["_resolvedNodeDefs"];
  const textKey = doc["_editStateKey"];
  const rootValues: Record<string, unknown> = root["_state"];
  const rootState: Record<string, Json> = {};
  let stateful = false;
  const rootDefinition = definitions.get(root.type)!;
  // In the order of the definition, the same in every replica.
  for (const key in rootDefinition.state) {
    // The text goes apart.
    if (key === textKey || !(key in rootValues)) continue;
    const value = storedValue(root, rootDefinition, rootValues, key);
    if (value === undefined) continue;
    rootState[key] = value;
    stateful = true;
  }
  const sessions = new SessionTable();
  const textColumns: { encode(): string }[] = [];
  const text =
    textKey !== undefined && textKey in rootValues
      ? textDefinition(doc, root.type, textKey).toStored!(
          rootValues[textKey],
          sessions,
          textColumns,
          root.id,
        )
      : 0;
  const columns: ColumnWriter[] = [];
  /** The names of types and keys, each once, by their index. */
  const names = new Map<string, number>();
  const values: Json[] = [];
  // Only text: the columns of the tree, last, are empty.
  if (root.first) writeTree(doc, sessions, columns, names, values);
  // Sessions mostly share their start with the one before, the first with
  // the document's id.
  const shared = new ColumnWriter();
  const table = frontCode(sessions.table, root.id, shared);
  // An empty element is `0`.
  return storedDoc(table, root.type, [
    stateful ? rootState : 0,
    // Letters without state are stored as their string alone. The text
    // goes before the columns: gzip compresses the letters better first.
    text !== 0 && text.length === 1 ? text[0] : text,
    // How much each session shares, the text's, then the tree's (see
    // `COLUMN_*`): a document of text alone ends with the text's.
    joinColumns([...sharedColumn(table, shared), ...textColumns, ...columns]) ||
      0,
    names.size ? [...names.keys()] : 0,
    values.length ? values : 0,
  ]);
}

/** Whether a stored document has its state, the only object after its type. */
const hasState = (
  json: JsonDoc,
): json is [string[], string, StoredState, ...StoredRest] => isRecord(json[2]);

/**
 * Builds the nodes of a stored `json` in `doc`, in place of its root. The
 * document's id is the one `Doc.fromJSON` gave it.
 */
export function readJsonDoc(doc: Doc, json: JsonDoc): void {
  const [table, type] = json;
  const [
    rootState,
    text = 0,
    storedColumns = 0,
    storedNames = 0,
    storedValues = 0,
  ] = elementsOf(json);
  // An element left out, or `0`, is empty.
  const names = storedNames || [];
  const values = storedValues || [];
  const id = doc.root.id;
  const rootDefinition = doc["_storedDefinition"](type);
  const state: Record<string, unknown> = {};
  // An empty state is `0`.
  if (rootState)
    for (const key in rootState)
      state[key] = doc["_storedValue"](rootDefinition, key, rootState[key]!);
  const columns = splitColumns(storedColumns || "");
  // Of more than one session, how much each shares is the first column.
  const start = table.length > 1 ? 1 : 0;
  const sessions = readSessions(
    frontDecode(table, id, new ColumnReader(columns.slice(0, start).join(""))),
  );
  // The tree's columns come after the text's.
  let first = start;
  if (text !== 0) {
    const textKey = doc["_editStateKey"];
    if (textKey === undefined)
      throw new Error(
        "The stored document has text, but no node type defines it (see `defineText`).",
      );
    const definition = textDefinition(doc, type, textKey);
    const stored = typeof text === "object" ? text : [text];
    first += definition.storedColumns!(stored);
    state[textKey] = definition.fromStored!(
      stored,
      columns.slice(start, first),
      sessions,
      id,
    );
  }
  const reader = (field: number) =>
    new ColumnReader(columns[first + field] ?? "");
  const root = doc["_storedNode"](id, type, state);
  doc["_setStoredRoot"](root);
  const sessionColumn = reader(COLUMN_SESSION);
  const clockColumn = reader(COLUMN_CLOCK);
  const typeColumn = reader(COLUMN_TYPE);
  const childrenColumn = reader(COLUMN_CHILDREN);
  const stateColumn = reader(COLUMN_STATE);
  const keyColumn = reader(COLUMN_KEY);
  const numberColumn = reader(COLUMN_NUMBER);
  /** The definition of each type, by its index in `names`. */
  const definitions: ResolvedNodeDefinition[] = [];
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
      const type = names[index]!;
      const definition = (definitions[index] ??=
        doc["_storedDefinition"](type));
      const state = new definition.Values();
      for (let count = stateColumn.next(); count > 0; count--) {
        const code = keyColumn.next();
        const key = names[code >> 1]!;
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
      const node = doc["_storedNode"](id, type, state);
      doc["_linkStored"](parent, prev, node);
      prev = node;
      attach(node);
    }
    // @ts-expect-error - read-only property
    parent.last = prev;
  };
  attach(root);
}

/**
 * The first column, how much each session shares with the one before (see
 * `frontCode`), which a table of one session or none does not have.
 */
export const sharedColumn = (
  table: readonly string[],
  shared: ColumnWriter,
): ColumnWriter[] => (table.length > 1 ? [shared] : []);

/** The columns of a stored `json`: an element left out, or `0`, has none. */
export const columnsOf = (json: JsonDoc) => {
  const columns = elementsOf(json)[2];
  return typeof columns === "string" ? columns : "";
};

/**
 * The sessions of the table of a stored `json` (see `JsonDoc`), `id` the
 * document's: what `readJsonDoc` reads, for a CRDT engine.
 */
export const storedSessions = (json: JsonDoc, id: string): string[] =>
  readSessions(
    frontDecode(
      json[0],
      id,
      new ColumnReader(
        json[0].length > 1 ? splitColumns(columnsOf(json), 1)[0]! : "",
      ),
    ),
  );

/** The elements of a stored document after its type, its state first (`0` when empty). */
export function elementsOf(json: JsonDoc): [StoredState | 0, ...StoredRest] {
  if (hasState(json)) {
    const [, , ...elements] = json;
    return elements;
  }
  const [, , ...rest] = json;
  return [0, ...rest];
}

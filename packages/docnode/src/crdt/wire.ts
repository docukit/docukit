import type {
  EditTextRow,
  InsertTextAgainRow,
  FlatRow,
  Head,
  LetterRef,
  Operations,
  OperationsRow,
} from "../operations.js";
import type { Json } from "../types.js";
import { base64ToNumber, lastDot, numberToBase64 } from "../idGenerator.js";
import { clockOf, distanceTo, literal } from "../wire.js";
import { isList } from "../utils.js";

/**
 * What the CRDT engines add to a batch of `wire.ts`. An engine's own row goes
 * right after the head, as an array that starts with its tag, 3 or 4: the
 * rows of `wire.ts` start with 0, 1, 2 or 5, a negative number, a string or
 * an array.
 *
 * Node ids in an engine's row are written as the batch writes them: a node
 * `session.clock` is `"index.clock"`, its session by its index in the head,
 * and a node of the head's session can be a number, its distance from the
 * head's counter (see `wire.ts`).
 */

/** A row of an engine: its tag, then what the engine writes. */
export type EngineRow = readonly [tag: number, ...payload: Json[]];

type FlatText = readonly [string, ...LetterRef[]];

type EngineThenFlat =
  | readonly [EditTextRow, ...FlatRow]
  | readonly [EditTextRow, ...FlatText];

type Rest =
  | OperationsRow[]
  | FlatRow
  | FlatText
  | InsertTextAgainRow
  | EngineThenFlat;

/** A batch of one row leaves out its brackets: its head and then the row. */
const isFlat = (rest: Rest): rest is FlatRow | FlatText | InsertTextAgainRow =>
  typeof rest[0] === "string" || typeof rest[0] === "number";

const isEngine = (row: Json | undefined) =>
  isList(row) && (row[0] === 3 || row[0] === 4);

/** One engine row, then a row without its brackets (see `joinRows`). */
const isEngineThenFlat = (rest: Rest): rest is EngineThenFlat =>
  isEngine(rest[0]) &&
  (typeof rest[1] === "string" || typeof rest[1] === "number");

/**
 * The rows of a batch, with the brackets of a batch of one row put back, also
 * after an engine row (see `joinRows`).
 */
function rowsOf(batch: Operations): OperationsRow[] {
  const [, ...rest] = batch;
  if (isFlat(rest)) return [rest];
  if (isEngineThenFlat(rest)) {
    const [engine, ...row] = rest;
    return [engine, row];
  }
  return rest;
}

const isTextInsert = (row: OperationsRow): row is FlatText =>
  isList(row) && typeof row[0] === "string";

const isFlatRow = (row: OperationsRow): row is FlatRow =>
  isList(row) && typeof row[0] === "number";

/** The engine row of a batch with the tag `tag`, if it has one. */
export function engineRow(
  batch: Operations,
  tag: number,
): readonly Json[] | undefined {
  const row = batch[1];
  return isList(row) && row[0] === tag ? row : undefined;
}

/** `batch` without its engine row. */
export function withoutEngineRow(batch: Operations): Operations {
  const rows = rowsOf(batch).slice(1);
  // A batch keeps a row: an empty state patch is a row too.
  const empty: OperationsRow = [-9];
  return [batch[0], ...(rows.length > 0 ? rows : [empty])];
}

/**
 * The rows of a batch but the ones of its tree (inserts, deletes and moves of
 * nodes, which start with 0, 1 or 2): its text edits and its state patch.
 */
export function textRows(batch: Operations): OperationsRow[] {
  return rowsOf(batch).filter(
    (row) => !(isList(row) && (row[0] === 0 || row[0] === 1 || row[0] === 2)),
  );
}

/** The id `writeId` wrote as `written`. */
export function readId(written: string, session: (index: number) => string) {
  if (written.charCodeAt(0) === 33) return written.slice(1);
  const dot = written.indexOf(".");
  if (dot === -1) return written;
  let index = 0;
  for (let i = 0; i < dot; i++) index = index * 10 + written.charCodeAt(i) - 48;
  return session(index) + written.slice(dot);
}

/**
 * A node id `session.clock` as `"index.clock"`, its session by `index`; `""`
 * for the index 0. Any other id is itself, with a `!` in front if it starts
 * with one. As `wire.ts` writes node ids.
 */
export function writeId(id: string, index: (session: string) => number) {
  const dot = lastDot(id);
  if (dot === -1) return literal(id);
  const at = index(id.slice(0, dot));
  return at === 0 ? id.slice(dot) : `${at}${id.slice(dot)}`;
}

/** The engine row, then the batch's own rows: one goes without brackets. */
function joinRows(
  head: Head,
  row: EngineRow,
  rows: readonly OperationsRow[],
): Operations {
  if (rows.length === 1) {
    const only = rows[0]!;
    if (isTextInsert(only)) return [head, row, ...only];
    if (isFlatRow(only)) return [head, row, ...only];
  }
  return [head, row, ...rows];
}

/**
 * The node ids of a batch: a session by its index in the head, as `wire.ts`
 * writes and reads them. Sessions an engine row names that the head does not
 * are added to it.
 */
export class Sessions {
  /** The first one is the head's own, then the others. */
  readonly #list: string[];
  readonly #named: string;
  readonly #length: number;
  /** The head's counter, which nodes are written from; -1 if it has none. */
  readonly #base: number;

  readonly #head: Head;

  constructor(head: Head) {
    this.#head = head;
    const named = typeof head === "string" ? head : head[0]!;
    const dot = lastDot(named);
    this.#named = named;
    this.#base = dot === -1 ? -1 : base64ToNumber(named, dot + 1);
    this.#list = [dot === -1 ? named : named.slice(0, dot)];
    if (typeof head !== "string") this.#list.push(...head.slice(1));
    this.#length = this.#list.length;
  }

  /** The index of a session, added if the head does not name it. */
  index(session: string): number {
    const list = this.#list;
    for (let index = 0; index < list.length; index++)
      if (list[index] === session) return index;
    // A head that names no session: nothing points to its first one yet.
    if (list.length === 1 && list[0] === "" && this.#named === "") {
      list[0] = session;
      return 0;
    }
    return list.push(session) - 1;
  }

  session(index: number): string {
    return this.#list[index]!;
  }

  /** `id` as a batch writes it: a node of the head's session can be a number. */
  write(id: string): string | number {
    const distance = distanceTo(id, this.#list[0]!, this.#base);
    return distance !== 0
      ? distance
      : writeId(id, (session) => this.index(session));
  }

  /** The id a batch wrote as `written` (`""` if it is neither a string nor a number). */
  read(written: Json | undefined): string {
    if (typeof written === "number")
      return `${this.#list[0]!}.${numberToBase64(clockOf(written, Math.max(this.#base, 0)))}`;
    return readId(
      typeof written === "string" ? written : "",
      (index) => this.#list[index]!,
    );
  }

  /** The head, with the sessions added since. */
  head(): Head {
    const list = this.#list;
    let named = this.#named;
    // A counter after it, so that a session with a dot is read back whole.
    if (named === "" && list[0] !== "") named = `${list[0]}.-`;
    if (list.length === this.#length && named === this.#named)
      return this.#head;
    return list.length === 1 ? named : [named, ...list.slice(1)];
  }
}

/** A batch with `row` right after its head (see `engineRow`). */
export function withEngineRow(
  sessions: Sessions,
  row: EngineRow,
  rows: readonly OperationsRow[],
): Operations {
  return joinRows(sessions.head(), row, rows);
}

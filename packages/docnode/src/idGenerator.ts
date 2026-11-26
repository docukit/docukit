import type { Doc } from "./main.js";

// RFC 4648 §5 alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
// But Lexicographically sorted.
const base64Alphabet =
  "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const ALPH_LEN = 64;
const FIRST_CHAR = base64Alphabet[0]!;

// O(1) char -> index map
const IDX = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPH_LEN; i++) IDX[base64Alphabet.charCodeAt(i)] = i;

function numberToBase64(num: number): string {
  if (num === 0) return FIRST_CHAR;
  let result = "";
  while (num > 0) {
    result = base64Alphabet[num % 64] + result;
    num = Math.floor(num / 64);
  }
  return result;
}

function randomStringBase64(len: number): string {
  const out = new Array(len);
  const CHARS_PER_U32 = 5;
  const u32Count = Math.ceil(len / CHARS_PER_U32);
  const buf32 = new Uint32Array(u32Count);
  crypto.getRandomValues(buf32);
  let o = 0; // output index
  for (let i = 0; i < u32Count; i++) {
    const v = buf32[i]!;
    for (let k = 0; k < CHARS_PER_U32 && o < len; k++) {
      out[o++] = base64Alphabet[(v >>> (k * 6)) & 63]!;
    }
  }
  return out.join("");
}

function incrementStringInBase64(str: string): string {
  const n = str.length;
  for (let i = n - 1; i >= 0; i--) {
    const idx = IDX[str.charCodeAt(i)]!;
    /* v8 ignore if -- @preserve */
    if (idx < 0) throw new Error("Invalid base64 digit");
    if (idx !== ALPH_LEN - 1) {
      const tailLen = n - i - 1;
      // bump current digit, reset the tail to the first alphabet char
      return (
        str.slice(0, i) +
        base64Alphabet[idx + 1] +
        (tailLen ? FIRST_CHAR.repeat(tailLen) : "")
      );
    }
    // carry continues
  }
  // all digits were max, prepend next and reset the rest
  return base64Alphabet[1] + FIRST_CHAR.repeat(n);
}

/**
 * The clock of an id `session.clock` whose dot is at `dot`, if
 * `numberToBase64` writes it back the same (up to 8 digits); else -1. Every
 * place that splits a node id uses it, so all agree on which ids are
 * `session.clock`.
 */
export function clockAt(id: string, dot: number) {
  const length = id.length - dot - 1;
  if (dot < 1 || length < 1 || length > 8) return -1;
  if (length > 1 && id.charCodeAt(dot + 1) === 45) return -1; // "-" = 0
  let clock = 0;
  for (let i = dot + 1; i < id.length; i++) {
    const digit = IDX[id.charCodeAt(i)] ?? -1;
    if (digit < 0) return -1;
    clock = clock * ALPH_LEN + digit;
  }
  return clock;
}

/** The number a `numberToBase64` string stands for, from `from` to its end. */
function base64ToNumber(text: string, from: number) {
  let num = 0;
  for (let i = from; i < text.length; i++)
    num = num * ALPH_LEN + IDX[text.charCodeAt(i)]!;
  return num;
}

/**
 * The node ids of a document's session: `session.clock`, the session being
 * the milliseconds since the root was created and a few random characters,
 * and the clock growing from 0, so that ids grow monotonically and seldom
 * collide.
 *
 * Two replicas can still get the same session. Like Yjs with its client id
 * (`cleanupTransactions`), a replica that receives an id of its session that
 * it did not make yet takes a new session (`collides`, `renew`): what it
 * writes next can no longer collide. What collided before stays as it was.
 *
 * It also keeps the table of the sessions its nodes are of, like the client
 * ids of Yjs's struct store: a node keeps the index of its session and its
 * clock as numbers, so its id can be written without parsing it again.
 */
export class NodeIds {
  private readonly _createdAt: number;
  private _session = "";
  private _clock = FIRST_CHAR;
  /** How many ids this session made: `_clock` as a number. */
  private _made = 0;
  /** The sessions of the document's nodes, by index. */
  private _sessions: string[] = [];
  /** The index of each session, made when there is a second one. */
  private _indexes: Map<string, number> | undefined;
  /** The index of `_session` in `_sessions`. */
  private _index = 0;
  /** The clock of the id `split` read last. */
  private _splitClock = 0;

  constructor(doc: Doc, extractTime: (id: string) => number) {
    const rootId = doc.root.id;
    try {
      this._createdAt = extractTime(rootId);
    } catch (error) {
      throw new Error(
        `Failed to extract time from root id '${rootId}'. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.renew();
  }

  /** The next id. */
  readonly generate = () => {
    const id = `${this._session}.${this._clock}`;
    this._clock = incrementStringInBase64(this._clock);
    this._made++;
    return id;
  };

  /** Starts a new session: later ids are of it. */
  renew() {
    // Absolute: a root clock ahead of this device would leave the time part empty.
    const milisecondsPassed = Math.abs(Date.now() - this._createdAt);
    this._session = numberToBase64(milisecondsPassed) + randomStringBase64(3);
    this._clock = FIRST_CHAR;
    this._made = 0;
    this._index = this.register(this._session);
  }

  /** The index of `session` in the table, which gets it if it is new. */
  register(session: string) {
    const sessions = this._sessions;
    if (sessions[0] === session) return 0;
    // A literal of one: a first push would reserve 17 slots.
    if (sessions.length === 0) return ((this._sessions = [session]), 0);
    this._indexes ??= new Map([[sessions[0]!, 0]]);
    let index = this._indexes.get(session);
    if (index === undefined) {
      index = sessions.push(session) - 1;
      this._indexes.set(session, index);
    }
    return index;
  }

  /**
   * The index of the session of an id of the form `session.clock`, which
   * the table gets if it is new, and its clock in `splitClock`. An id that
   * would not be written back the same from them (one of a custom
   * generator) gives -1.
   */
  split(id: string) {
    const dot = id.lastIndexOf(".");
    const clock = clockAt(id, dot);
    if (clock < 0) return -1;
    this._splitClock = clock;
    return this.register(id.slice(0, dot));
  }

  /** The clock of the id `split` read last. */
  get splitClock() {
    return this._splitClock;
  }

  /**
   * Whether `id` is of this session, with a clock it has not reached: only
   * another replica with the same session makes it. Ids it made itself (an
   * undo, a change sent back) are behind.
   */
  collides(id: string) {
    const length = this._session.length;
    return (
      id.charCodeAt(length) === 46 &&
      id.startsWith(this._session) &&
      base64ToNumber(id, length + 1) >= this._made
    );
  }
}

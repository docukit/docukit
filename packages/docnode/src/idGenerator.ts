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

const DIGITS = [...base64Alphabet];
/**
 * Every number of two digits, written once: counters and clocks are written
 * on every batch, and a string made by joining two digits is a new one.
 */
let pairs: string[] | undefined;

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

/**
 * Where the last dot of `id` is, or -1. A loop: `lastIndexOf` is a call into
 * the engine, and ids are split on every save and load.
 */
export function lastDot(id: string): number {
  let at = id.length - 1;
  while (at >= 0 && id.charCodeAt(at) !== 46) at--;
  return at;
}

export function numberToBase64(num: number): string {
  // Most clocks and counters have up to three digits.
  if (num < 64) return DIGITS[num]!;
  pairs ??= DIGITS.flatMap((high) => DIGITS.map((low) => high + low));
  if (num < 4096) return pairs[num]!;
  if (num < 262144) return DIGITS[num >> 12]! + pairs[num & 4095]!;
  let result = "";
  while (num > 0) {
    result = DIGITS[num % 64]! + result;
    num = Math.floor(num / 64);
  }
  return result;
}

/**
 * The clock of a node id `session.clock`, its dot at `dot`, if the clock is
 * written as `numberToBase64` writes it, in up to `digits` digits; else -1.
 * Every place that splits a node id uses it, so all agree on which ids are
 * `session.clock`.
 */
export function clockAt(id: string, dot: number, digits = 8): number {
  const length = id.length - dot - 1;
  // A leading zero digit ("-") would not be written back the same.
  if (
    length < 1 ||
    length > digits ||
    (length > 1 && id.charCodeAt(dot + 1) === 45)
  )
    return -1;
  let clock = 0;
  for (let i = dot + 1; i < id.length; i++) {
    const digit = digitOf(id.charCodeAt(i));
    if (digit < 0) return -1;
    clock = clock * 64 + digit;
  }
  return clock;
}

/** The value of a base 64 digit's character code, or -1. */
const digitOf = (code: number): number => IDX[code] ?? -1;

export function incrementStringInBase64(str: string): string {
  const n = str.length;
  for (let i = n - 1; i >= 0; i--) {
    // A digit outside base 64 (in a custom node id) counts as one before the
    // first: the text only needs every replica to get the same id.
    const idx = IDX[str.charCodeAt(i)]!;
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

/** The number a `numberToBase64` string stands for, from `from` to its end. */
export function base64ToNumber(text: string, from = 0): number {
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
 */
export class NodeIds {
  readonly #createdAt: number;
  #session = "";
  #clock = FIRST_CHAR;
  /** How many ids this session made: `#clock` as a number. */
  #made = 0;

  constructor(doc: Doc, extractTime: (id: string) => number) {
    const rootId = doc.root.id;
    try {
      this.#createdAt = extractTime(rootId);
    } catch (error) {
      throw new Error(
        `Failed to extract time from root id '${rootId}'. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.renew();
  }

  /** The next id. */
  readonly generate = () => {
    const id = `${this.#session}.${this.#clock}`;
    this.#clock = incrementStringInBase64(this.#clock);
    this.#made++;
    return id;
  };

  /** Starts a new session: later ids are of it. */
  renew() {
    // Absolute: a root clock ahead of this device would leave the time part empty.
    const milisecondsPassed = Math.abs(Date.now() - this.#createdAt);
    this.#session = numberToBase64(milisecondsPassed) + randomStringBase64(3);
    this.#clock = FIRST_CHAR;
    this.#made = 0;
  }

  /**
   * Whether `id` is of this session, with a clock it has not reached: only
   * another replica with the same session makes it. Ids it made itself (an
   * undo, a change sent back) are behind.
   */
  collides(id: string) {
    const length = this.#session.length;
    return (
      id.charCodeAt(length) === 46 &&
      id.startsWith(this.#session) &&
      base64ToNumber(id, length + 1) >= this.#made
    );
  }
}

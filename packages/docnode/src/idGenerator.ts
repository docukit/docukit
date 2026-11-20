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
 */
export class NodeIds {
  private readonly _createdAt: number;
  private _session = "";
  private _clock = FIRST_CHAR;
  /** How many ids this session made: `_clock` as a number. */
  private _made = 0;

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

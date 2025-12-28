import { decodeTime } from "ulid";
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
 * Function (factory) that returns another function (generator).
 *
 * It doesn't return an ID, but rather a function that generates IDs when called.
 *
 * This is done so that it can generate monotonically increasing IDs,
 * reducing the probability of collisions.
 *
 * @param doc
 * @returns nodeIdGenerator
 */
export const nodeIdFactory = (doc: Doc) => {
  const rootId = doc.root.id;
  let createdAt: number;
  try {
    // Convert to uppercase because ulid's decodeTime expects uppercase Crockford Base32
    createdAt = decodeTime(rootId.toUpperCase());
  } catch (error) {
    /* v8 ignore next -- @preserve */
    throw new Error(
      `Invalid doc/root id: ${rootId}. It must be a valid ULID. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const milisecondsPassed = Date.now() - createdAt;
  const milisecondsInBase64 = numberToBase64(milisecondsPassed);
  const randomString = randomStringBase64(3);
  const sessionId = milisecondsInBase64 + randomString;
  let clock = FIRST_CHAR;

  const nodeIdGenerator = () => {
    const id = `${sessionId}.${clock}`;
    clock = incrementStringInBase64(clock);
    return id;
  };

  return nodeIdGenerator;
};

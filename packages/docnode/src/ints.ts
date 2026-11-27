// The integer column of a stored document (see `JsonDoc`): the state values
// that are 32-bit integers, written as the base64 of their bytes, while their
// place in `values` holds `0`. Like lib0's `writeAny`, only 32-bit integers go
// there; any other number stays a JSON number. Like the value columns of
// Automerge and Loro, they are bytes, not decimal digits. Unlike their LEB128,
// every integer of a column takes the same bytes (1, 2 or 4, the fewest that
// fit them all: the bytes of an `Int8Array`, `Int16Array` or `Int32Array`),
// so typed arrays convert them natively, without a loop per byte. The bytes
// start with a header of that many bytes, the first one the width, so that
// the integers start aligned.

/** `Uint8Array.prototype.toBase64` (ES2026), where the runtime has it. */
type Bytes = Uint8Array & {
  toBase64?: (options: { omitPadding: boolean }) => string;
};

/** `Uint8Array.fromBase64` (ES2026), where the runtime has it. */
const BytesConstructor: Uint8ArrayConstructor & {
  fromBase64?: (text: string) => Uint8Array;
} = Uint8Array;

/** Chunks of `String.fromCharCode`: spreading a big array overflows the stack. */
const CHUNK = 0x2000;

/**
 * The integer column of `ints`, all of them 32-bit integers. `bits` is the
 * OR of `n ^ (n >> 31)` of each: the bits that the widest one needs.
 */
export function writeInts(ints: number[], bits: number) {
  const width = bits < 0x80 ? 1 : bits < 0x8000 ? 2 : 4;
  const buffer = new ArrayBuffer(width + ints.length * width);
  const bytes: Bytes = new Uint8Array(buffer);
  bytes[0] = width;
  if (width === 1) new Int8Array(buffer, 1).set(ints);
  else if (width === 2) new Int16Array(buffer, 2).set(ints);
  else new Int32Array(buffer, 4).set(ints);
  // Node 22 and 24 have no `toBase64`: `Buffer`, or else `btoa`.
  if (bytes.toBase64) return bytes.toBase64({ omitPadding: true });
  if (typeof Buffer === "function")
    return Buffer.from(buffer).toString("base64").replace(/=+$/, "");
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/=+$/, "");
}

/** The integers of an integer column. */
export function readInts(column: unknown) {
  if (typeof column !== "string")
    throw new Error("Invalid stored document: its integers are not valid.");
  const bytes = fromBase64(column);
  const width = bytes[0];
  if ((width !== 1 && width !== 2 && width !== 4) || bytes.length % width !== 0)
    throw new Error("Invalid stored document: its integers are not valid.");
  // `bytes` is a new array, so its buffer starts aligned.
  return width === 1
    ? new Int8Array(bytes.buffer, 1)
    : width === 2
      ? new Int16Array(bytes.buffer, 2)
      : new Int32Array(bytes.buffer, 4);
}

function fromBase64(text: string) {
  if (BytesConstructor.fromBase64) return BytesConstructor.fromBase64(text);
  // A copy: the array `Buffer` returns can be a view into a shared pool.
  if (typeof Buffer === "function")
    return new Uint8Array(Buffer.from(text, "base64"));
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

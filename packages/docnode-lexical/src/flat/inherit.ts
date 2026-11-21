/**
 * One key per text format bit (bold "0", italic "1", ...): two users' bold and
 * italic both stay. A key that reads as a number is a number on the wire.
 */
export const FORMAT_KEYS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
];
/** Inline elements: `@` a link, `@type` any other. */
export const inlineKey = (type: string) => (type === "link" ? "@" : `@${type}`);

/**
 * The letter that ends a line, whose state holds the block. DEL: one byte in
 * a JSON string, never typed, and apart from the `\n` of soft line breaks.
 */
export const PARAGRAPH = "\x7f";
/** An inline decorator: one letter whose `e` state is its JSON. */
export const OBJECT = "\ufffc";

/**
 * What a letter typed without a value of its own reads (see `defineText` in
 * DocNode): the format and style of the letter it was typed after, and the
 * link or mark around it only from inside. Paragraph letters and inline
 * decorators inherit nothing, so nothing goes on past the end of a line.
 */
export const INHERIT = {
  inherit: {
    ...Object.fromEntries(FORMAT_KEYS.map((key) => [key, "origin" as const])),
    y: "origin",
    [inlineKey("link")]: "both",
    [inlineKey("autolink")]: "both",
    [inlineKey("mark")]: "both",
  },
  opaque: PARAGRAPH + OBJECT,
} as const;

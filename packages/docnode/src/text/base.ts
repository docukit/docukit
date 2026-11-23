import type {
  InternalStateDefinition,
  Json,
  StateDefinition,
} from "../types.js";
import { textState, type InheritRules } from "./common.js";
import { BaseText } from "./baseText.js";
import { textDefinition, type TextHandle } from "./defineText.js";

/**
 * Base's text: a list per node in the server's order (see `BaseText`). Made
 * by the first `defineText`: an app without text does not bundle it.
 */
let rootDefinition: InternalStateDefinition | undefined;

/**
 * Opt-in collaborative text: a list of letters per node, and a state per
 * letter and key where the last write wins. In Base the server's order
 * places letters (see `BaseText`); with a CRDT engine, FugueMax does.
 * `inherit`: the keys a letter without a value of its own reads from the
 * letters it was typed between (see `Inherit`), like
 * `{ bold: "origin", link: "both", "comment:*": "both" }`. `opaque`: the
 * characters whose letters inherit nothing, like one that ends a paragraph.
 * A document with a CRDT engine can take `defineText` of
 * `@docukit/docnode/crdt` instead, which does not bundle Base's text.
 */
export function defineText(options?: {
  inherit?: InheritRules;
  opaque?: string;
}): StateDefinition<number, Json, TextHandle> {
  return textDefinition(options, (rootDefinition ??= textState(BaseText)));
}

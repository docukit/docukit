import type {
  InternalStateDefinition,
  Json,
  StateDefinition,
} from "../types.js";
import type { InheritRules } from "../text/common.js";
import { textDefinition, type TextHandle } from "../text/defineText.js";

/** The text of a document without an engine: there is none here. */
const needsEngine: InternalStateDefinition = {
  fromJSON: () => {
    throw new Error(
      "`defineText` of `@docukit/docnode/crdt` needs a CRDT engine (`DocConfig.crdt`): use the one of `@docukit/docnode` without it.",
    );
  },
};

/**
 * `defineText` of `@docukit/docnode` for a document with a CRDT engine (see
 * `DocConfig.crdt`): the text is the engine's, and Base's is not bundled.
 */
export function defineText(options?: {
  inherit?: InheritRules;
  opaque?: string;
}): StateDefinition<number, Json, TextHandle> {
  return textDefinition(options, needsEngine);
}

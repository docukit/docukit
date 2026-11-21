import { expect, test } from "vitest";

import { runLexicalFuzz } from "./fuzz.js";

const SEEDS = Number(process.env.LEXICAL_FUZZ_SEEDS ?? 20);

test(
  `${SEEDS} concurrent Lexical histories converge, docs and views`,
  { timeout: Math.max(8000, SEEDS * 400) },
  () => {
    const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
    const stats = runLexicalFuzz(seeds);
    if (process.env.FUZZ_VERBOSE) console.log(JSON.stringify(stats));
    expect(stats.errors).toStrictEqual([]);
    expect(stats.docDivergent).toStrictEqual([]);
    expect(stats.viewDivergent).toStrictEqual([]);
  },
);

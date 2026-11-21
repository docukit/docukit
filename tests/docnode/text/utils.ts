import { defineNode, defineText, type DocNode } from "@docukit/docnode";

export const Paragraph = defineNode({ type: "p", state: { t: defineText() } });
export type ParagraphNode = DocNode<typeof Paragraph>;

/** A small deterministic generator, so a failing seed can be replayed. */
export function randomizer(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)]!,
    shuffle: <T>(items: readonly T[]): T[] => {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [result[i], result[j]] = [result[j]!, result[i]!];
      }
      return result;
    },
  };
}
export type Randomizer = ReturnType<typeof randomizer>;

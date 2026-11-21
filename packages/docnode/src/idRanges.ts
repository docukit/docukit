/**
 * Numeric ids per session as sorted, disjoint `[from, to, life]` runs, flat.
 * An overlap keeps the highest life, and neighbours with the same life join,
 * so the runs are the same whatever the order they were added in. The labels
 * engine keeps the deleted lives of its nodes in it, as Yjs keeps one
 * `DeleteSet` (`IdSet` in 14).
 */
export class IdRanges {
  /** session -> flat [from, to, life, from, to, life, ...], sorted by `from`. */
  protected _runs = new Map<string, number[]>();

  /** Whether nothing was added: an id needs no parsing to look it up. */
  isEmpty(): boolean {
    return this._runs.size === 0;
  }

  /** The life of `clock` in `session`, or -1 if it was never added. */
  get(session: string, clock: number): number {
    const runs = this._runs.get(session);
    if (!runs) return -1;
    let low = 0;
    let high = runs.length / 3;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (runs[middle * 3 + 1]! < clock) low = middle + 1;
      else high = middle;
    }
    const at = low * 3;
    return at < runs.length && runs[at]! <= clock ? runs[at + 2]! : -1;
  }

  add(session: string, from: number, to: number, life: number) {
    let runs = this._runs.get(session);
    if (!runs) this._runs.set(session, (runs = []));
    // Ids mostly come in order: after the last run, or touching it.
    const count = runs.length;
    if (count === 0 || runs[count - 2]! < from - 1) {
      runs.push(from, to, life);
      return;
    }
    if (runs[count - 3]! <= from && runs[count - 1] === life) {
      runs[count - 2] = Math.max(runs[count - 2]!, to);
      return;
    }
    // Only the runs that touch [from - 1, to + 1] can change or join it.
    let first = 0;
    let high = count / 3;
    while (first < high) {
      const middle = (first + high) >> 1;
      if (runs[middle * 3 + 1]! < from - 1) first = middle + 1;
      else high = middle;
    }
    let last = first;
    while (last * 3 < count && runs[last * 3]! <= to + 1) last++;
    const touched = runs.slice(first * 3, last * 3);
    const out: number[] = [];
    let start = from;
    let i = 0;
    const push = (a: number, b: number, l: number) => {
      const n = out.length;
      if (n > 0 && out[n - 2] === a - 1 && out[n - 1] === l) {
        out[n - 2] = b;
      } else {
        out.push(a, b, l);
      }
    };
    for (; i < touched.length && touched[i + 1]! < from; i += 3) {
      push(touched[i]!, touched[i + 1]!, touched[i + 2]!);
    }
    while (start <= to) {
      if (i >= touched.length || touched[i]! > to) {
        push(start, to, life);
        break;
      }
      const [a, b, l] = [touched[i]!, touched[i + 1]!, touched[i + 2]!];
      if (a < start) push(a, start - 1, l);
      if (a > start) {
        push(start, a - 1, life);
        start = a;
      }
      const end = Math.min(b, to);
      push(start, end, Math.max(l, life));
      if (b > to) push(to + 1, b, l);
      start = end + 1;
      i += 3;
    }
    for (; i < touched.length; i += 3)
      push(touched[i]!, touched[i + 1]!, touched[i + 2]!);
    runs.splice(first * 3, last * 3 - first * 3, ...out);
  }

  /** Each session with its runs: `from, to, life` one after the other. */
  forEach(callback: (session: string, runs: readonly number[]) => void) {
    this._runs.forEach((runs, session) => callback(session, runs));
  }
}

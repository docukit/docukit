// The predefined second heap history (README rule 13): loaded with `node --import heap-preload.ts` before the
// benchmark process starts, it allocates a fixed 16 MB of short-lived objects and keeps none of them. It changes only
// where V8's young-generation GCs fall in the rows that follow, not what the rows do.
// All the objects are reachable only through `batch`, which is overwritten on every step and cleared at the end, so
// they all become garbage. Writing to a module-level variable keeps the optimizer from removing the allocations.
import { getHeapStatistics } from "node:v8";
const TARGET = 16 * 1024 * 1024;
const allocated = () => getHeapStatistics().total_allocated_bytes;
let batch: unknown[] | undefined;
const a0 = allocated();
let i = 0;
while (allocated() - a0 < TARGET) {
  const b: unknown[] = [];
  for (let k = 0; k < 1000; k++, i++)
    b.push({ i, s: `x${i}`, a: [i, i + 1, i + 2] });
  batch = b;
}
batch = undefined;
if (process.env.HEAP_PRELOAD_DEBUG === "1")
  console.error(
    `heap-preload: ${((allocated() - a0) / 1048576).toFixed(1)} MB allocated, ${i} objects, kept: ${batch === undefined ? "none" : "some"}`,
  );

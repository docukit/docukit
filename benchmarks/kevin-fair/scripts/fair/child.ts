// One benchmark process: one library, all the rows, upstream harness copy `cb/js-lib-fair`.
// usage (env W = work folder, default: benchmarks/kevin-fair): node --expose-gc --max-old-space-size=2048 child.ts <time|extra> <subject> <rows> <out.json>
//  time : upstream columns + exact windows + loadNoGc (+ ins when FAIR_IC=1) + memFair + memFairWarm.
//  extra: one row per process; wraps applyUpdate/getEncodedState to count the update stream and the stored doc
//         (bytes and gzip-9). Never used for timing.
// env FAIR_WARM (default 2): warm-up passes before the measured one. Each runs the same rows with the plain factory and
//  its results are dropped, so every library is measured with its code already optimized, like a long session. The
//  random inputs come from one seeded generator, so the measured pass gets the same inputs for every library.
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [mode, subject, rowsArg, out] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const WARM = Number(process.env.FAIR_WARM ?? 2);
const prefixes = rowsArg.split(",");
const wanted = (n: string) => prefixes.some((p) => n.startsWith(p));
const toBytes = (u: any) =>
  typeof u === "string"
    ? Buffer.from(u)
    : Buffer.from(u.buffer, u.byteOffset, u.byteLength);
const gz = (b: Buffer) => gzipSync(b, { level: 9 }).length;
try {
  let Factory: any;
  if (subject === "yjs13")
    Factory = (
      await import(pathToFileURL(`${W}/cb/benchmarks/yjs/factory.js`).href)
    ).YjsFactory;
  else if (subject === "yjs14")
    Factory = (
      await import(pathToFileURL(`${W}/cb/benchmarks/yjs14/factory.js`).href)
    ).Yjs14Factory;
  else if (subject === "yjs13xml")
    Factory = (
      await import(pathToFileURL(`${W}/cb/benchmarks/yjs/factory-xml.js`).href)
    ).YjsXmlFactory;
  else if (subject === "yjs14node")
    Factory = (
      await import(
        pathToFileURL(`${W}/cb/benchmarks/yjs14/factory-node.js`).href
      )
    ).Yjs14NodeFactory;
  else
    Factory = (await import(pathToFileURL(`${W}/bundles/${subject}.mjs`).href))
      .DocNodeFactory;
  const inner = new Factory();
  let factory: any = inner;
  const encodedByRun: unknown[] = [];
  const stat = { updates: 0, bytes: 0 };
  const chunks: Buffer[] = [];
  const emitted = { updates: 0, bytes: 0 };
  const emittedChunks: Buffer[] = [];
  let encoded: Buffer | undefined;
  if (mode === "time") {
    // The harness's own memUsed can start from a heap that still holds the previous document. Keep each row's stored
    // document and measure memory at the end, from a clean heap, the same way for every library (memFair / memFairWarm).
    const wrap = (crdt: object) =>
      new Proxy(crdt, {
        get(t: any, p) {
          const v = Reflect.get(t, p, t);
          if (p === "getEncodedState")
            return () => {
              const e = t.getEncodedState();
              encodedByRun.push(e);
              return e;
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    factory = {
      create: (h: unknown) => wrap(inner.create(h)),
      load: (h: unknown, bin: unknown) => inner.load(h, bin),
      getName: () => inner.getName(),
    };
  } else {
    // The stream of a row = what the harness delivers: each distinct update passed to applyUpdate (B1-B3). B4 has
    // one replica and delivers nothing: its stream is what that replica emits.
    const seen = new Set<unknown>();
    const emit = (h: (u: any) => void) => (u: any) => {
      emitted.updates++;
      emitted.bytes += u.length;
      emittedChunks.push(Buffer.from(toBytes(u)));
      h(u);
    };
    const wrap = (crdt: object) =>
      new Proxy(crdt, {
        get(t: any, p) {
          const v = Reflect.get(t, p, t);
          if (p === "applyUpdate")
            return (u: any) => {
              if (!seen.has(u)) {
                seen.add(u);
                stat.updates++;
                stat.bytes += u.length;
                chunks.push(Buffer.from(toBytes(u)));
              }
              return t.applyUpdate(u);
            };
          if (p === "getEncodedState")
            return () => {
              const s = t.getEncodedState();
              encoded ??= Buffer.from(toBytes(s));
              return s;
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    factory = {
      create: (h: (u: any) => void) => wrap(inner.create(emit(h))),
      load: (h: unknown, bin: unknown) => wrap(inner.load(h, bin)),
      getName: () => inner.getName(),
    };
  }
  const lib = await import(
    pathToFileURL(`${W}/cb/js-lib-${process.env.HARNESS ?? "fair"}/index.js`)
      .href
  );
  const info = console.info,
    log = console.log;
  console.info = () => {};
  console.log = () => {};
  try {
    for (let w = 0; w < WARM; w++) await lib.runBenchmarks(inner, wanted);
    lib.resetResults();
    await lib.runBenchmarks(factory, wanted);
    if (lib.finishGc) await lib.finishGc();
  } finally {
    console.info = info;
    console.log = log;
  }
  const results: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(lib.benchmarkResults))
    results[k] = Object.values(v as object)[0] as string | number;
  if (mode === "time") {
    const rows = [
      ...new Set(
        Object.keys(results)
          .filter((k) => k.endsWith("(encodeTime)"))
          .map((k) => k.slice(0, k.lastIndexOf(" ("))),
      ),
    ];
    const gc = (globalThis as any).gc as () => void;
    if (rows.length === encodedByRun.length) {
      // Wait for the event loop between GCs: an object still referenced by the current job (for example through a
      // WeakRef) is not freed by a synchronous gc(), and freeing it later inside the next window made Yjs 14 in B1.11
      // read 72 kB instead of 2.4 MB. The harness already ran each load, so no first-compile code is counted here.
      const tick = () => new Promise((r) => setTimeout(r, 0));
      const clean = async () => {
        await tick();
        gc();
        gc();
        await tick();
        gc();
        gc();
      };
      for (let i = 0; i < rows.length; i++) {
        await clean();
        let h0 = process.memoryUsage().heapUsed;
        let doc: unknown = inner.load(() => {}, encodedByRun[i]);
        await clean();
        results[`${rows[i]} (memFair)`] = process.memoryUsage().heapUsed - h0;
        doc = undefined;
        await clean();
        h0 = process.memoryUsage().heapUsed;
        doc = inner.load(() => {}, encodedByRun[i]);
        await clean();
        results[`${rows[i]} (memFairWarm)`] =
          process.memoryUsage().heapUsed - h0;
        doc = undefined;
      }
    }
    writeFileSync(
      out,
      JSON.stringify({ status: "ok", node: process.version, results }),
    );
  } else {
    // Nothing delivered (B4): the emitted stream.
    const own = stat.updates === 0;
    const all = Buffer.concat(own ? emittedChunks : chunks);
    writeFileSync(
      out,
      JSON.stringify({
        status: "ok",
        node: process.version,
        extra: {
          updates: own ? emitted.updates : stat.updates,
          bytes: own ? emitted.bytes : stat.bytes,
          streamGzip: all.length ? gz(all) : 0,
          docRaw: encoded?.length,
          docGzip: encoded ? gz(encoded) : undefined,
        },
      }),
    );
  }
} catch (e: any) {
  const msg = String(e?.stack ?? e)
    .split("\n")
    .slice(0, 6)
    .join(" | ");
  writeFileSync(
    out,
    JSON.stringify({
      status: /not supported/.test(msg) ? "not-supported" : "error",
      message: msg,
    }),
  );
}
process.exit(0);

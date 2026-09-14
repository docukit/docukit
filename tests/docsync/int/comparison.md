# Comparing the two worker-sync drafts

These are alternative implementations against the same `main` commit
(`238be6d`), not sequential changes to merge together:

- [Option A, PR #72](https://github.com/docukit/docukit/pull/72): use the existing
  `DocSyncClient` in pages and workers.
- [Option B, PR #71](https://github.com/docukit/docukit/pull/71): extract
  `DocSyncCore`; the page client extends it and workers use it directly.

Both contain the same IndexedDB identity migration, socket transport, per-document
sync lock and local-write flushing. Neither changes Fluski or introduces HTTP.

## Size and complexity

Physical lines include comments, imports and blank lines. Implementation counts
include all `.ts` files under `packages/docsync/src`, excluding tests and docs.
`main` has 4,251 such lines. These counts describe code size, not runtime memory.

| Metric                                 |           A |           B |
| -------------------------------------- | ----------: | ----------: |
| Total implementation lines             |       4,306 |       4,352 |
| Net growth over main                   |         +55 |        +101 |
| Implementation additions / deletions   | +170 / -115 | +832 / -731 |
| Implementation files changed over main |          10 |          24 |
| Main client/engine classes combined    |         738 |         776 |

B adds 46 implementation lines over A. Its large diff mostly moves code: the
640-line core contains the existing engine and the 136-line client contains the
external-store observer adapter and public presence methods. Most helper changes
only replace their client type/import with the core type/import. The separate
core export adds eight lines.

The core retains live CRDT documents, query state, retries, BroadcastChannel and
the presence protocol. It does not contain another reconciliation algorithm.
The concrete extra complexity is a public class, an entry point, inheritance and
a direct subscription contract. That contract needed handling for a callback
that throws at subscription time, duplicate callbacks and repeated release calls.
Three full client/server integration tests cover those cases and reconnects.

A uses the same API in both environments. B avoids the external-store adapter in
the worker, but gives the two consumers different subscription APIs:

```ts
// A: application-provided config, document ID and render callback.
const client = new DocSyncClient(config);
const observer = client.getDocObserver({ type: "notes", id: docId });
const release = observer.subscribe(render);

// B: the page uses the client above; the worker uses the shared engine.
const core = new DocSyncCore(config);
const releaseCore = core.subscribeDoc(
  { type: "notes", id: docId },
  handleState,
);
```

## Measurements

Final code, six alternating runs in order A/B/B/A/A/B. Each run has two warmups
and ten measured samples: 30 measured samples per option, 72 correctness-checked
cases including warmups. Every sample starts a fresh dedicated worker, loads an
existing small document from IndexedDB while disconnected, edits it, flushes it,
connects and synchronizes. The test then verifies the stored edit, zero pending
operations, delivery to another device and exactly one outgoing sync request.

| Median elapsed time                   |        A |        B |
| ------------------------------------- | -------: | -------: |
| Worker entry, from creation           | 19.15 ms | 20.40 ms |
| Local document ready, from creation   | 24.80 ms | 25.60 ms |
| Sync complete, from creation          | 40.45 ms | 41.65 ms |
| Worker entry to local document ready  |  5.10 ms |  5.20 ms |
| Local document ready to sync complete | 15.70 ms | 16.15 ms |
| Sync requests per case                |        1 |        1 |

These times use development modules served by Vite, including their loading
cost, rather than a production bundle. Identity and the document already exist
in IndexedDB. This is not a cold database/migration, mobile, large-document,
throughput or service-worker lifetime benchmark. Memory was not measured.
Other applications continued consuming CPU on the shared machine; they were not
stopped. Ranges overlap and the faster option changed between runs and between
the initial and final rounds. The result establishes no material speed advantage.

The same measurement worker bundled separately with esbuild 0.27.2, including
DocNode and Socket.IO dependencies:

| Download size |            A |            B |
| ------------- | -----------: | -----------: |
| Minified ESM  | 95,262 bytes | 93,971 bytes |
| Gzip, level 9 | 29,412 bytes | 29,056 bytes |

B saves 356 compressed bytes (1.21%). Dependency output outside DocSync is
identical in the bundle metadata. Bundle size and the development timings above
are different measurements; the size saving does not prove a startup saving.

Environment: Apple M3 Pro, macOS 26.5.1 arm64, Node 24.14.0, Vitest 4.0.17,
Playwright 1.60.0. Benchmark suites completed in 2.30–2.80 seconds.

## Reproduce

From each draft's worktree, with its dependencies installed:

```sh
VITE_DOCSYNC_BENCHMARK=1 pnpm test:once tests/docsync/int/comparison.browser.test.ts
```

The test prints `DOCSYNC_COMPARISON` with every sample and its summary. It is
skipped by the normal test suite so timing experiments do not slow everyday CI.

```sh
node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/bin/esbuild tests/docsync/int/comparison.worker.ts --bundle --minify --format=esm --platform=browser --conditions=vitest --outfile=/tmp/docsync-worker.bundle.js --metafile=/tmp/docsync-worker.meta.json
```

Read the output bytes directly; the compressed count uses Python
`len(gzip.compress(data, compresslevel=9, mtime=0))`. No bundler dependency was added.

## Validation and recommendation

A passed all 781 normal tests with coverage in 7.27 seconds. B passed all 784;
its final full-suite runs took 8.30 and 9.08 seconds amid concurrent machine load
(previous extraction run: 7.11 seconds). The over-8-second runs were investigated:
other Node/Chromium processes and applications were consuming substantial CPU.
These whole-suite timings are not used to compare sync efficiency. B also passed
its six core/worker tests against the compiled package in CI mode in 1.49 seconds.
Package builds and `pnpm fix` passed. DocNode's existing uncovered branch at
`main.ts:1004` remains unchanged. CI status is reported separately on each PR.

For the current background-sync requirement, prefer A: one public client/API,
less code movement and no demonstrated performance penalty compared with B.
B is a valid alternative if a direct engine API has independent value to future
consumers. Its small download saving alone does not justify the additional API.
Neither draft demonstrates an advantage in memory use or behavior at scale.

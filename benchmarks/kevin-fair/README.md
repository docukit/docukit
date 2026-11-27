# Fair Kevin benchmark

This folder measures DocNode against Yjs 13 and Yjs 14 with the rows of Kevin Jahns'
[crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks/tree/796f70250c8c003dfb3a50369d0b2733a760e54d)
(pinned at `796f7025`) that DocNode supports, plus two app-shaped documents. It keeps the upstream harness and its
columns, and adds what is needed to give a verdict you can trust: a load window without forced GC, a clean memory
measure, many rounds, two independent runs, and a fixed statistics rule.

It is the starting point for milestone 4 (benchmarks in the repo and CI guardrails). It is not part of the workspace,
the build, lint, typecheck or CI (see [Not checked by the repo tools](#not-checked-by-the-repo-tools)).

- Rows: B1.8–B1.11 (one user, arrays of numbers), B3.1–B3.4 (20√N users, maps and arrays), and **G1.9** (B1.9 with
  Yjs storing one element per number, see rule 12).
- Columns: bytes/update (gzip of the update stream), stored doc (gzip), **load** (without forced GC), Kevin's load
  (`parseTime`, shown only), memory, time (the whole row), save.
- App-shaped documents: a file-explorer tree (~2,000 nodes) and a docnode-lexical-shaped document (~10,000 nodes),
  with synthetic, seeded content.

## The method

Each rule exists because a measurement showed that the simpler way gave a wrong or unstable answer. "Evidence" is
from Node 26.13.1 on an Apple M3 Pro.

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence that motivated it                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Upstream harness untouched in its columns.** We only add timers next to them (`harness/js-lib-fair.patch`) and print 2 decimals instead of rounding.                                                                                                                                                                                                                                                    | Changing what upstream measures makes the numbers impossible to compare with anyone else's.                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | **The load verdict uses an inner window, "load without forced GC"** (`loadNoGc` = `load + check`, timed inside the same run). Kevin's `parseTime` stays visible as a % only.                                                                                                                                                                                                                              | In b1/b2/b3, `parseTime` wraps two forced full `gc()` calls (`getMemUsed` and `logMemoryUsed`). They are **74–91 %** of that column and their cost depends on everything alive in the heap, not on the loaded document. They inverted verdicts: B1.8 Kevin load −13 % (win) vs without GC +71 % (loss); B3.4 +17 % (loss) vs −69 % (win). Upstream removed the GC from the clock in 2021 (`7bc7027d`) and put it back in 2022 (`f07a885f`); b4 still times it outside. |
| 3   | **The fair harness loads the same editing-trace module as upstream** (a symlink, made by `setup.sh`).                                                                                                                                                                                                                                                                                                     | The Yjs 13 factory imports `../../js-lib/index.js`. With a second copy of the 29 MB trace in the heap, every forced GC got slower: Yjs 13 B1.8 Kevin load went from 30.9 to 63.3 ms.                                                                                                                                                                                                                                                                                   |
| 4   | **One fresh process per library and round, with all rows in it.** Same rows and same order for every library; rounds interleave the libraries and alternate their order; one process at a time; `--expose-gc --max-old-space-size=2048`. No extra `gc()` before steps and no `--single-threaded`.                                                                                                         | Which rows run before a row changes it by up to ±80 % (Yjs 13 B1.8 save 1.20 → 0.27 ms when B1.1–B1.7 do not run first), so every library must run the same rows. A `gc()` right before a step made the step run ~2× more instructions (Yjs 13 save: 14 M → 26 M; B1.9 save 0.27 → 2.63 ms). `--single-threaded` flipped B1.8 load from −13 % to +47 %.                                                                                                                |
| 5   | **No warm-up: one measurement per fresh process.**                                                                                                                                                                                                                                                                                                                                                        | A pilot that repeated each row 10 + 10 times in one process made the ~1 ms cells _noisier_, not calmer: the heap grows, GCs land inside the windows, and V8 re-optimizes with new random data. Warm-up is still useful as a diagnostic (`warm-pilot.ts`, see findings 5 and 7).                                                                                                                                                                                        |
| 6   | **30 rounds per library, two independent runs (A and B)**, one after the other.                                                                                                                                                                                                                                                                                                                           | With 5 rounds, the median of the same Yjs 13 code moved 98–117 % between runs, and one DocNode cell gave +8, +5, +4, −6 and +17 % in five runs. With 30 rounds, A and B gave the same verdict in 13 of 15 upstream cells and 5 of 5 load-without-GC cells; the 2 that changed moved between tie and win/loss, never from win to loss.                                                                                                                                  |
| 7   | **Fixed statistics** (`stats.ts`): median per cell; reference = the Yjs (13 or 14) with the lowest median over all 60 rounds; % = median / reference − 1; 95 % bootstrap interval (4,000 resamples, seed 12345, re-seeded for every interval). **Win / loss only if the whole interval is outside ±2 %**, and only if A and B agree; otherwise "tie (unstable)". No % when both medians are under 0.1 ms. | Picking the better Yjs separately in each run (the minimum of two noisy medians) was always biased against DocNode (up to −10 % in B1.9 load). In cells of 0.01–0.03 ms one clock step is 33–100 %. The fixed seed gives the same output for the same data.                                                                                                                                                                                                            |
| 8   | **Memory = `memFairWarm`**: at the end of the process, load each row's stored document a second time and measure the heap, with event-loop ticks between `gc()` calls (`await tick(); gc(); gc(); await tick(); gc(); gc()`). `memFair` (first load) and upstream `memUsed` stay in the raw data.                                                                                                         | Upstream `memUsed` starts from a heap that may still hold the previous document (Yjs: 0 B in B1.8, 287 % spread in B1.9). A synchronous `gc()` did not free an object still referenced by the current job: freed later, inside the next window, it made Yjs 14 in B1.11 read **72 kB instead of 2.4 MB**, and it created a fake ~200 kB "compiled code" difference between DocNode's first and second load.                                                            |
| 9   | **Bytes come from a separate pass** (`MODE=extra`, one row per process, 5 rounds, median), never from a timed run.                                                                                                                                                                                                                                                                                        | Random ids make sizes change between rounds (Yjs 13 B3.3 stored doc 36,821–38,389 B, 4 %), and counting bytes must not add work inside timed windows.                                                                                                                                                                                                                                                                                                                  |
| 10  | **Record the 1-minute load average before every process. Repeat a run when more than 25 % of its processes saw load > 6.**                                                                                                                                                                                                                                                                                | Machine load is a smaller source than the ones above, and thread CPU time instead of wall time barely reduced the spread, but busy runs (55–93 % of processes over load 6, with a VM using ~75 % of a core) were visibly off.                                                                                                                                                                                                                                          |
| 11  | **DocNode against DocNode also counts thread instructions** (`FAIR_IC=1`, 15 rounds; macOS on Apple Silicon only, `node:ffi` + `thread_selfcounts`). A change is better or worse only if time **and** instructions point the same way. **Never** compare instructions with Yjs.                                                                                                                           | Instruction spread was 0.4–8 % where the clock had 4–85 %. But instructions measure work, not time (B1.8 save: +0 % time, −13 % instructions), so they can confirm a DocNode change, not rank libraries.                                                                                                                                                                                                                                                               |
| 12  | **Also report G1.9**: B1.9 again, with Yjs storing one `XmlElement` (Yjs 13) or `Node` (Yjs 14) per number.                                                                                                                                                                                                                                                                                               | In B1.9 Yjs packs 6,000 numbers into one block, while DocNode makes 6,000 nodes. G1.9 compares the same shape (one node per value), the one DocNode is built for.                                                                                                                                                                                                                                                                                                      |
| 13  | **GC pauses and allocated bytes are diagnostics only** (`FAIR_GC=1`).                                                                                                                                                                                                                                                                                                                                     | GC pauses (`PerformanceObserver('gc')`) never fell inside save or load windows. `total_allocated_bytes` is too coarse for ~1 ms windows (30–99 % spread), but fine for whole rows.                                                                                                                                                                                                                                                                                     |

What noise is left in short cells is V8's JIT state. Rules 6 and 7 cover it, except one case: a **bimodal V8 state
whose frequency differs per library** (the "B1.11 coin", finding 5). A and B agreement does not catch it, because the
bias is the same in both runs. Detecting it by splitting instruction counts into their two modes is a known option,
not implemented.

## Commands

Requirements: macOS or Linux, Node 26 (the scripts run as `.ts` with Node's type stripping; the instruction counter
needs Node 26's `node:ffi` and macOS on Apple Silicon), `curl`, `patch`. Run everything from this folder. **Never run
two benchmark processes at the same time** (the runners already run one at a time).

```sh
cd benchmarks/kevin-fair
./setup.sh   # downloads crdt-benchmarks @796f7025 into cb/, applies the patches, installs Yjs 13, Yjs 14 and esbuild
```

### Measure the best Yjs + the current DocNode + a candidate

Both Yjs versions always run; each cell uses the better one as the reference. A DocNode subject is a DocuKit checkout
in `trees/<name>`, bundled with the crdt-benchmarks adapter into `bundles/<name>.mjs`.

```sh
git worktree add --detach trees/current origin/main
git worktree add --detach trees/candidate <your-branch>
node scripts/build.ts trees/current scripts/docnodeAdapter.ts bundles/current.mjs
node scripts/build.ts trees/candidate scripts/docnodeAdapter.ts bundles/candidate.mjs

export SUBJECTS=yjs13,yjs14,current,candidate BASE=current NEW=candidate OUT_DIR=$PWD/out/candidate
node scripts/fair/all.ts                       # runs A and B, bytes, instructions, statistics (roughly 20 min for 4 subjects)
node scripts/fair/docs-all.ts                  # app-shaped documents (~2 min)
node scripts/fair/ic-compare.ts "$OUT_DIR"     # candidate against current: time and instructions
node scripts/fair/report.ts "$OUT_DIR"         # writes $OUT_DIR/report.md
git worktree remove trees/current && git worktree remove trees/candidate
```

`all.ts` takes steps (`runs,extra,ic,compare`), for example `node scripts/fair/all.ts compare` only recomputes the
statistics. Other variables: `ROUNDS` (30), `EXTRA_ROUNDS` (5), `IC_ROUNDS` (15), `W` (work folder, default this
folder). The 7-subject run behind the findings took 39 minutes, including 5 repeats for machine load.

### Diagnostics

```sh
FAIR_GC=1 node --expose-gc scripts/fair/child.ts time candidate "[B1.8]" out/gc.json      # GC pauses and allocated bytes per window
WARM=10 MEAS=10 node --expose-gc scripts/fair/warm-pilot.ts candidate "[B1.8],[B1.9]" out/warm.json   # warm vs first run
```

### Output files (in `OUT_DIR`)

| File                                           | What it holds                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `kevin-A.json`, `kevin-B.json`, `g19-A/B.json` | Raw samples of every window, the load average of every process and the Node version |
| `kevin-xA/xB.json`, `g19-xA/xB.json`           | Bytes pass                                                                          |
| `ic-A/B.json`, `docs-ic-A/B.json`              | Instruction counts (BASE and NEW only)                                              |
| `fair-summary.json`, `fair-docs-summary.json`  | Per cell: median, min, max, %, intervals of A, B and both, verdicts                 |
| `fair-ic-summary.json`                         | NEW against BASE: time verdict, instruction verdict, judgement                      |
| `report.md`                                    | All of the above as tables                                                          |

## Folder layout

| Path                                                 | What it is                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                           | Downloads crdt-benchmarks, builds `cb/js-lib-fair` and the extra Yjs factories from the patches, installs dependencies. Safe to run again.                                                                                          |
| `harness/js-lib-fair.patch`                          | Upstream `js-lib` → fair copy: exact windows (`<column> exact`), `loadNoGc`, `FAIR_IC` (instructions), `FAIR_GC` (GC pauses, allocated bytes), 2 decimals. Upstream columns keep their meaning.                                     |
| `harness/yjs13-xml-factory.patch`                    | Upstream Yjs 13 factory → one `Y.XmlElement` per number (G1.9).                                                                                                                                                                     |
| `harness/yjs14/`                                     | Yjs 14 (`@y/y` 14.0.0-rc.29) factory, which upstream does not have, with its lockfile. Plain JS on purpose (see its header).                                                                                                        |
| `harness/yjs14-node-factory.patch`                   | Yjs 14 factory → one `Y.Node` per number (G1.9).                                                                                                                                                                                    |
| `scripts/docnodeAdapter.ts`                          | DocNode adapter for the harness (Base mode). The harness is the network; a module-level counter is the server order; a replica with pending updates rebases on a foreign one. `pending` keeps the update bytes, not the operations. |
| `scripts/build.ts`, `build-lib.ts`                   | Bundle a DocNode tree (or a prebuilt library bundle) with the adapter.                                                                                                                                                              |
| `scripts/fair/all.ts`, `run.ts`, `child.ts`          | Orchestrator, runner (one process per library and round, load check, exit code 3 = repeat) and the measured process (adds `memFair`, `memFairWarm`; bytes mode).                                                                    |
| `scripts/fair/stats.ts`, `compare.ts`                | The fixed statistics and the per-cell summary.                                                                                                                                                                                      |
| `scripts/fair/docs*.ts`, `build-docs.ts`             | App-shaped documents probe (DocNode and Yjs build the same seeded content) and its statistics.                                                                                                                                      |
| `scripts/fair/ic-compare.ts`, `icount.ts`            | DocNode against DocNode with instructions; the thread instruction counter.                                                                                                                                                          |
| `scripts/fair/report.ts`, `warm-pilot.ts`            | Markdown report; warm-up pilot.                                                                                                                                                                                                     |
| `cb/`, `deps/`, `trees/`, `bundles/`, `out/`, `tmp/` | Work folders, git-ignored. Never commit raw output or bundles.                                                                                                                                                                      |

### Not checked by the repo tools

The folder is excluded from the root `tsc`, ESLint and Knip. The scripts are research code: they use `any` for the
JSON they pass around and for the adapter (which must work across DocNode trees with different APIs), and they need
Node 26-only APIs (`node:ffi`). Prettier still formats them, except `harness/` (kept in upstream style so the
patches apply). Milestone 4 should type them before they become part of CI (see the last section).

## Findings

Libraries in the tables: **Milestone 1** (the tip of the milestone 1 stack) and **Nd** (a candidate on top of it that
stores loose integers as bytes in the saved document). % against the best Yjs; negative = better than Yjs.

### 1. The forced GC inside Kevin's load decides its verdict

Same run, same samples: Kevin's `parseTime` against the inner window (ms, median of 30 rounds, Yjs 13 vs Milestone 1).

| Row  | Kevin load, Yjs / DocNode | Load without GC, Yjs / DocNode | Verdict with Kevin load | Verdict without GC |
| ---- | ------------------------- | ------------------------------ | ----------------------- | ------------------ |
| B1.8 | 30.9 / 26.9               | 4.0 / 6.9                      | −13 % win               | +71 % loss         |
| B3.4 | 20.0 / 23.5               | 6.8 / 2.1                      | +17 % loss              | −69 % win          |

A `gc()` costs 0.9 ms in an empty Node and 5.9 ms with the harness loaded (the B4 trace alone is 29 MB). In B3 the
column punishes whoever keeps more memory alive (20√N documents), not whoever loads slower.

### 2. Where the noise came from (largest first)

| Source                                       | Size                                                     | Handled by                    |
| -------------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| Forced GC inside Kevin's load                | 74–91 % of the column; inverts verdicts                  | Rule 2                        |
| Which rows ran before                        | up to ±80 % in short cells                               | Rule 4                        |
| 5 rounds, no interval                        | medians move up to ±50 %; signs flip near 0              | Rules 6, 7                    |
| Bimodal JIT/GC state                         | e.g. Yjs 13 B1.9 save spread 67 % (43 % in instructions) | Rules 6, 7 (except finding 5) |
| Leftovers of the previous document in memory | Yjs `memUsed` 0 B in B1.8                                | Rule 8                        |
| Random ids                                   | sizes up to 4 %                                          | Rule 9                        |
| Machine load (load 2.7–6.8)                  | smaller than all of the above                            | Rule 10                       |
| CPU frequency / heat                         | not visible (`pmset -g therm` clean, cycles/ms flat)     | —                             |

### 3. DocNode against Yjs (first fair run, 30 rounds × 2)

Cells with a verdict (9 rows incl. G1.9 × 6 columns: bytes, stored doc, load, memory, time, save):

| Library     | win | loss | tie | unstable |
| ----------- | --- | ---- | --- | -------- |
| Milestone 1 | 38  | 15   | 1   | 0        |
| Nd          | 42  | 11   | 1   | 0        |

Memory in that run used a synchronous `gc()` (fixed afterwards, rule 8), so its memory cells for B1.10/B1.11 were
wrong. Measured again with event-loop ticks (median of 5, `memFairWarm`):

| Row   | Yjs 13   | Yjs 14   | Milestone 1 | Nd       |
| ----- | -------- | -------- | ----------- | -------- |
| B1.8  | 65 kB    | 65 kB    | 1,326 kB    | 1,353 kB |
| B1.9  | 55 kB    | 75 kB    | 1,324 kB    | 1,351 kB |
| B1.10 | 2,288 kB | 2,379 kB | 1,410 kB    | 1,415 kB |
| B1.11 | 2,299 kB | 2,399 kB | 1,292 kB    | 1,292 kB |
| B3.4  | 1,014 kB | 1,019 kB | 436 kB      | 442 kB   |
| G1.9  | 6,241 kB | 7,792 kB | 1,133 kB    | 1,218 kB |

All of Nd's losses are in the rows with a plain array of numbers (B1.8, B1.9, B1.11): load +72–75 %, memory ~20×
(B1.8, B1.9), B1.9 time +469 % and save +391 %. That is Yjs packing consecutive numbers into one block. (The table
above counts B1.11 memory as a loss; with the fixed measure it is a win: 1,292 vs 2,299 kB, −44 %.) In **G1.9** (one node per
number on both sides) Nd wins load −61 %, memory −81 %, time −21 %, save −23 %, stored doc −19 %, and only loses
bytes/update (+2.8 %). B3.1–B3.3: every column wins by 45–100 % (DocNode's stored doc there is 70–90 B).

Medians of the best Yjs used as reference in that run:

| Row   | bytes/update | stored doc | load     | time      | save     |
| ----- | ------------ | ---------- | -------- | --------- | -------- |
| B1.8  | 59.7 kB      | 29.7 kB    | 4.02 ms  | 144.50 ms | 1.19 ms  |
| B1.9  | 29.7 kB      | 29.7 kB    | 3.19 ms  | 3.44 ms   | 0.243 ms |
| G1.9  | 30.0 kB      | 30.0 kB    | 15.94 ms | 29.65 ms  | 1.74 ms  |
| B1.10 | 60.1 kB      | 29.7 kB    | 7.21 ms  | 150.12 ms | 1.36 ms  |
| B1.11 | 79.3 kB      | 51.9 kB    | 8.73 ms  | 155.27 ms | 1.28 ms  |
| B3.4  | 12.5 kB      | 11.6 kB    | 5.91 ms  | 45.44 ms  | 1.82 ms  |

App-shaped documents (Milestone 1 against the best Yjs, 30 rounds): explorer save −71 %, load −57 %, gzip −37 %,
memory −80 %; Lexical save −81 %, load −70 %, gzip −21 %, raw JSON +16 % (loss), memory −69 %.

### 4. Integers as bytes in the stored document (Nd)

| Question             | Answer                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Size                 | Stored doc B1.8–B1.10 30.9 → 24.4 kB gzip (**−21 %**; from +3.9 % to −18 % against Yjs). B1.11 46.4 → 40.7 kB. Bytes/update unchanged (operations do not change).                                                                                                                                                                                |
| Load                 | Same as Milestone 1 (time and instructions within ±2 %) in B1.8–B1.10. An earlier "+11 % cold load" in B1.8 was forced-GC noise: the second `gc()` alone varies 9–20 ms between identical processes. B1.11: see finding 5.                                                                                                                       |
| Save                 | B1.8 worse (+7.9 % time, +8.8 % instructions, ≈ +0.1 ms cold); B1.10 better (−12 % / −10 %).                                                                                                                                                                                                                                                     |
| Old runtimes         | `Uint8Array.prototype.toBase64` / `fromBase64` exist in Node 25+ only, so Node 22 and 24 need a fallback. The first fallback (`btoa(String.fromCharCode(...bytes))`) was slow and breaks on large arrays (Node 24: save cold +73 %, warm +109 %). The chain native → `Buffer` → `btoa` in 8 K chunks costs 0 to +0.3 ms cold per 6,000 integers. |
| App-shaped documents | Same (no loose integers in their state, so the codec never runs).                                                                                                                                                                                                                                                                                |

### 5. The B1.11 "coin" (a V8 state, not a DocNode change)

In B1.11, Nd seemed to load 25 % slower than Milestone 1. It was a coin toss inside V8:

- The same library with the same data runs ≈ 70 M instructions (≈ 5.3 ms) or ≈ 90 M (≈ 6.8 ms). Within each state,
  both libraries are equal (±1 %).
- Cause: in B1.10's load, V8 compiles `_readJson` with Maglev. The harness's forced `gc()` just before B1.11's window
  sometimes clears that code ("embedded weak objects cleared"), and the loop runs in a lower tier (~7,100 instead of
  ~4,500 instructions per node). 16 of 16 traces: cleared before the load ⇔ ≈ 90 M.
- The frequency of the slow state changed with almost anything: Milestone 1 6/30 and Nd 29/30 in the official run;
  33–50 % for both in other sessions; reversed when tracing was on.
- Rules 6 and 7 did not catch it because the bias was the same in run A and run B. Options: report B1.11 load per
  state (instructions > 80 M = slow), add a "B1.11 alone" control run (always the slow state, 94 M for both), or mark
  a cell unstable when the share of slow rounds differs between libraries by more than 30 points. None is implemented.
- Warm-up (rule 5) removed the coin.

### 6. Where DocNode's garbage and GC time come from

| Question                                      | Answer                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GC share of the whole row                     | 13–31 % for DocNode, 2–3 % for Yjs. GC pauses never fell inside save or load windows.                                                                                                                                    |
| Why                                           | Mostly what stays **alive** (a young GC copies survivors), not the garbage. After creating 6,000 nodes in B1.8: DocNode 11.7 MB alive vs Yjs 13 2.1 MB, although Yjs allocates 4.6× more (603 vs 132 MB).                |
| The adapter's share                           | ~7 MB of those 11.7 MB were operation arrays the adapter kept in `pending`. Fixed: `pending` now keeps the update bytes (4.0 MB alive).                                                                                  |
| Where the garbage is allocated                | ~95 % is fixed work per transaction: writing/reading the operations format (`encodeOperations` / `decodeOperations`, ~25 %) and per-transaction bookkeeping (change event, `_forceCommit`, `withTransaction`, ~25–35 %). |
| What a prototype saved (whole row, 12 rounds) | Change event as a class, codec loops without closures or iterators, loops in `onApplyOperations`, plus the adapter fix: time B1.8 −27 %, B1.10 −13 %, B1.11 −30 %, B3.4 −47 %; GC pauses −47 to −74 %. Save unchanged.   |

### 7. DocNode's load gap in B1.8 / B1.9 is mostly first-run cost

| Row  | Gap vs Yjs, first run | Gap warm (10 + 10 in one process) | Share that is first-run cost |
| ---- | --------------------- | --------------------------------- | ---------------------------- |
| B1.8 | +2.92 ms (+74 %)      | +1.20 ms (+36 %)                  | 59 %                         |
| B1.9 | +2.62 ms (+92 %)      | +0.65 ms (+20 %)                  | 75 %                         |

The rest is per-node CPU work: the load window includes the harness's `check`, which reads `node.state.v.get()`
18,000 times (44 % of the gap in B1.8, 70 % in B1.9). GC pauses in the window: 0. Removing garbage did not move it;
a lazier `state` accessor that allocated 50 % less was _slower_.

### Not verified

- Browsers (Chrome, Firefox, Safari), Linux, and CI runners: nothing here was measured there.
- The instruction counter uses a private macOS API (`thread_selfcounts`) and the experimental `node:ffi`.
- Why a `gc()` right before a step doubles the step's instructions; which weak object decides the B1.11 coin.
- Rows run are B1.8–B1.11 and B3.1–B3.4 only (DocNode has no text type for B1.1–B1.7, B2, B4), so Yjs runs "colder"
  than in a full upstream run.

## Next steps for milestone 4

1. **Make it repo code.** Type the scripts (no `any`), drop the folder from the ignore lists, and decide which parts
   become a package with its own `package.json` (esbuild, ulid, the Yjs versions) instead of `setup.sh` installs.
2. **Guardrails that do not depend on the clock first.** Stored-doc size and bytes/update are deterministic up to the
   random ids (≤ 4 %); `memFairWarm` has a narrow range. They can fail CI with a simple threshold today.
3. **Time guardrails: candidate against `main` in the same job**, with rules 4, 6 and 7 (interleaved rounds, A and
   B, interval outside ±2 %). Hosted runners are noisier than this Mac, so start with a report, not a failing check,
   and tune the band from real CI data.
4. **An instruction counter for Linux** (`perf_event_open`, or `perf stat` where the runner exposes hardware
   counters; GitHub-hosted VMs usually do not). Otherwise consider Valgrind/cachegrind for a deterministic count.
5. **Catch the B1.11 coin** (finding 5): split instruction counts by mode or add the "B1.11 alone" control.
6. **Keep raw output as CI artifacts** (`out/`), never in git, and keep the report short: the verdict columns, with
   Kevin's load next to it.

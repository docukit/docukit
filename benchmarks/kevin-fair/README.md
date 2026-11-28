# Fair Kevin benchmark

This folder measures DocNode against Yjs 13 and Yjs 14 with the rows of Kevin Jahns'
[crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks/tree/796f70250c8c003dfb3a50369d0b2733a760e54d)
(pinned at `796f7025`) that DocNode supports, plus two app-shaped documents. It keeps the upstream harness and its
columns, and adds what is needed to give a verdict you can trust: a load window without forced GC, a clean memory
measure, many rounds, two runs checked for drift, a fixed statistics rule, and GC diagnostics that qualify but never
decide an outcome.

It is the starting point for milestone 4 (benchmarks in the repo and CI guardrails). It is not part of the workspace,
the build, lint, typecheck or CI (see [Not checked by the repo tools](#not-checked-by-the-repo-tools)).

- Rows: B1.8–B1.11 (one user, arrays of numbers), B3.1–B3.4 (20√N users, maps and arrays), and **G1.8** and **G1.9**
  (B1.8 and B1.9 with Yjs storing one element per number, see rule 12).
- Columns: bytes/update (uncompressed), stored doc (gzip and uncompressed), **load** (without forced GC), Kevin's load
  (`parseTime`, shown only), memory, time (the whole row), save.
- App-shaped documents: a file-explorer tree (~2,000 nodes) and a docnode-lexical-shaped document (~10,000 nodes),
  with synthetic, seeded content.

## The method

Each rule exists because a measurement showed that the simpler way gave a wrong or unstable answer. "Evidence" is
from Node 26.13.1 on an Apple M3 Pro.

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence that motivated it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Upstream harness untouched in its columns.** We only add timers next to them (`harness/js-lib-fair.patch`) and print 2 decimals instead of rounding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Changing what upstream measures makes the numbers impossible to compare with anyone else's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **The load verdict uses an inner window, "load without forced GC"** (`loadNoGc` = `load + check`, timed inside the same run). Kevin's `parseTime` stays visible as a % only. `loadNoGc` excludes the forced GC from its window, but not its influence (the heap it leaves is the one the load runs in). **time** (the whole row) includes neither save nor load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | In b1/b2/b3, `parseTime` wraps two forced full `gc()` calls (`getMemUsed` and `logMemoryUsed`). They are **74–91 %** of that column and their cost depends on everything alive in the heap, not on the loaded document. They inverted verdicts: B1.8 Kevin load −13 % (win) vs without GC +71 % (loss); B3.4 +17 % (loss) vs −69 % (win). Upstream removed the GC from the clock in 2021 (`7bc7027d`) and put it back in 2022 (`f07a885f`); b4 still times it outside.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **The fair harness loads the same editing-trace module as upstream** (a symlink, made by `setup.sh`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The Yjs 13 factory imports `../../js-lib/index.js`. With a second copy of the 29 MB trace in the heap, every forced GC got slower: Yjs 13 B1.8 Kevin load went from 30.9 to 63.3 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | **One fresh process per library and round, with all rows in it.** Same rows and same order for every library; rounds interleave the libraries and alternate their order; one process at a time; `--expose-gc --max-old-space-size=2048`. No extra `gc()` before steps and no `--single-threaded`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Which rows run before a row changes it by up to ±80 % (Yjs 13 B1.8 save 1.20 → 0.27 ms when B1.1–B1.7 do not run first), so every library must run the same rows. A `gc()` right before a step made the step run ~2× more instructions (Yjs 13 save: 14 M → 26 M; B1.9 save 0.27 → 2.63 ms). `--single-threaded` flipped B1.8 load from −13 % to +47 %.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | **Warm-up: two unrecorded passes of the same rows, then one measured pass, in each fresh process** (`FAIR_WARM`, default 2; the app-shaped documents load and save their document twice first). Every library gets the same passes, and the inputs come from one seeded generator, so the measured pass has the same inputs for every library.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A save is usually not the first one of a session, and a cold window mixes the code with when V8 optimizes it: in B1.11 save, V8 dropped and recompiled the optimized `toJSON` code in the middle of the window, because B1.11 is the first row whose ids do not form runs. B1.8 time of DocNode with 0, 1, 2 and 4 warm-up passes: 41, 34, 31 and 31 ms (6 processes each). An older pilot that _measured_ each row 10 + 10 times in one process was noisier (the heap grows and GCs land inside the windows); here each process still measures once, and rule 6 keeps 30 + 30 processes. `FAIR_WARM=0` gives the cold, upstream-like run.                                                                                                                                                                                                                                                                                |
| 6   | **30 + 30 valid rounds per library: two runs (A and B), one after the other**, with `FAIR_GC` off. A and B are a drift check, not two votes (rule 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | With 5 rounds, the median of the same Yjs 13 code moved 98–117 % between runs, and one DocNode cell gave +8, +5, +4, −6 and +17 % in five runs. Against a 200-round truth (`out/gc-truth.json`), the mean of 30 cold rounds has ~0 % bias and ±5 % spread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | **Fixed statistics** (`stats.ts`). Estimate = **arithmetic mean** of the exact ms; libraries compared as a **ratio of means** (% = mean / reference mean − 1); median shown as secondary. Interval: **pooled 95 % paired bootstrap** that resamples matched two-round blocks (rounds 2k and 2k+1, so the alternating order stays inside a block), separately within A and B, then pooled; 4,000 resamples, seed 12345. Reference = the better Yjs (lower mean): both Yjs are compared with simultaneous Bonferroni intervals (97.5 % each), the interval against the better one is [larger lower end, larger upper end], and both Yjs are shown. **Better / worse only if the whole interval is beyond ±2 %; equivalent only if it is wholly inside ±2 %; otherwise inconclusive.** "No verdict: A/B drift" when A and B fall on opposite practical sides (one beyond +2 %, the other beyond −2 %) or the interval of their difference lies wholly outside ±2 points. Flags, never changing the outcome: **low precision** (a mean's interval reaches more than 5 % from it), **fragile** (leaving out one matched round moves the % by more than 2 points; the round is kept). Both means under 0.1 ms: absolute difference only, no outcome. Memory and bytes use the same rule (mean). | 200 cold rounds of B1.8–B1.11 with FAIR_GC=1 (`out/gc-truth.json`): in B1.11 save, a GC pause fell inside the window in **200/200** rounds for c140 (main after #140) and **0/200** for c138 (before #139) and Yjs 13, although c140's save allocated less (2,265 vs 2,542 KB). True means: Yjs 13 1.069 ms, c138 1.439, c140 2.955. Estimators against the true mean (bootstrap of n rounds from the 200): **median of cold samples biased ±5 %** (at n = 30 spread up to ±13 %), because the pause is in the tail; **mean: bias ~0 %, spread ±5 % at n = 30**; "minus observed pauses" and "minus pauses + bytes × GC ms per byte" **−50 %** for c140; 100 repeated warm saves −47 % to −88 % (warm code: a different quantity). Picking the better Yjs separately in each run was biased against DocNode (up to −10 % in B1.9 load); Bonferroni pays for the choice. In 0.01–0.03 ms cells one clock step is 33–100 %. |
| 8   | **Memory = `memFairWarm`**: at the end of the process, load each row's stored document a second time and measure the heap, with event-loop ticks between `gc()` calls (`await tick(); gc(); gc(); await tick(); gc(); gc()`). `memFair` (first load) and upstream `memUsed` stay in the raw data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Upstream `memUsed` starts from a heap that may still hold the previous document (Yjs: 0 B in B1.8, 287 % spread in B1.9). A synchronous `gc()` did not free an object still referenced by the current job: freed later, inside the next window, it made Yjs 14 in B1.11 read **72 kB instead of 2.4 MB**, and it created a fake ~200 kB "compiled code" difference between DocNode's first and second load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Bytes come from a separate pass** (`MODE=extra`, one row per process, 5 + 5 rounds, mean), never from a timed run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Random ids make sizes change between rounds (Yjs 13 B3.3 stored doc 36,821–38,389 B, 4 %), and counting bytes must not add work inside timed windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 10  | **Record the 1-minute load average before every process. A batch where more than 25 % of the processes start with load > 6 is invalid**: it is repeated (up to 3 tries), and a batch still busy after the tries is **never used for a verdict**: its cells say "no verdict: busy machine".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Machine load is a smaller source than the ones above, and thread CPU time instead of wall time barely reduced the spread, but busy runs (55–93 % of processes over load 6, with a VM using ~75 % of a core) were visibly off. Keeping the last busy try (the old rule) let a 63 %-busy run A decide cells.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **DocNode against DocNode also counts thread instructions** (`FAIR_IC=1`, 15 rounds; macOS on Apple Silicon only, `node:ffi` + `thread_selfcounts`). A change is better or worse only if time **and** instructions point the same way. **Never** compare instructions with Yjs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Instruction spread was 0.4–8 % where the clock had 4–85 %. But instructions measure work, not time (B1.8 save: +0 % time, −13 % instructions), so they can confirm a DocNode change, not rank libraries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 12  | **Also report G1.8 and G1.9**: B1.8 and B1.9 again, with Yjs storing one `XmlElement` (Yjs 13) or `Node` (Yjs 14) per number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Yjs merges numbers inserted one after the other into one block (`Item.mergeWith` needs `right.origin` to be the last id): all 6,000 in B1.9, and each append in B1.8. DocNode makes one node per number. G1.8 and G1.9 compare the same shape (one node per value), the one DocNode is built for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13  | **GC is a diagnostic, never an outcome.** A separate 30-round pass with `FAIR_GC=1` (same rows, subjects and order) reports per window and library: share of rounds with a GC pause inside, mean pause inside, mean without the observed pause, MB allocated. If the pause share differs from the reference's by more than 20 points, the outcome reads "… **in the fixed benchmark sequence; size sensitive to GC placement**". Load cells also show MB allocated and the pause count, and "higher allocation during load" at ≥ 2× the reference (no GC cost implied). Confirmation, never automatic: (a) a separate 60 + 60 run of named cells with 97.5 % intervals that decides on its own (both shown); (b) a **second predefined heap history** (`heap-preload.ts`: 16 MB of short-lived garbage at process start), 30 + 30 rounds, all libraries: if either history is inconclusive or they disagree, the cross-history outcome is inconclusive; if they agree, "robust across the histories tested". Small probes may flag, never decide.                                                                                                                                                                                                                                         | B1.11 save above: the pause decides the size of the c140 gap (+105 % vs c138 by the true means) but subtracting pauses removes ~half of a real cost. **Preload probe** (random 0–32 MB of short-lived garbage at start, 40 rounds): c140 save paused in 21/40 rounds (mean 2.244 ms), c138 in 0/40 (1.466 ms); c140 vs c138 went from +105 % to +53 %: the size is sensitive to GC placement, the direction held. **Official harness**: 0/160 GC pauses inside `loadNoGc` (c138/c140, B1.8–B1.11, 40 rounds) while DocNode allocated 10.5–12.4 MB per load. **FAIR_GC on/off** (finding 8): no window moved beyond ±2 %, but none was shown equivalent either, so we do not claim that pauses land in the same place with FAIR_GC off.                                                                                                                                                                                    |
| 14  | **Bytes per update are counted uncompressed; the stored doc with gzip and uncompressed.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | DocSync sends updates through Socket.IO, which does not compress them by default (and, when on, skips messages under 1 kB). Gzip of one small update makes it bigger: B1.8 DocNode 52.8 → 69.8 B, Yjs 13 32.2 → 53.2 B. Gzip of the whole stream (9–14 B per update) models a compression no transport here applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

What noise is left in short cells is V8's JIT and GC state. Rules 6, 7 and 13 cover it, except one case: a **bimodal
V8 state whose frequency differs per library** (the "B1.11 coin", finding 5). The A/B drift check does not catch it,
because the bias is the same in both runs. Detecting it by splitting instruction counts into their two modes is a known option,
not implemented.

## Commands

Requirements: macOS or Linux, Node 26 (the scripts run as `.ts` with Node's type stripping; the instruction counter
needs Node 26's `node:ffi` and macOS on Apple Silicon), `curl`, `patch`. Run everything from this folder. **Never run
two benchmark processes at the same time** (the runners already run one at a time).

```sh
cd benchmarks/kevin-fair
./setup.sh   # downloads crdt-benchmarks @796f7025 into cb/, applies the patches, installs Yjs 13, Yjs 14 and esbuild
```

### Quick check of a DocNode change (default, ~2–4 min)

The default for every change and for a PR description, marked "quick". Give it two git refs (or two checkouts):

```sh
node scripts/fair/quick-compare.ts origin/main <your-branch>              # rows picked from the changed files
node scripts/fair/quick-compare.ts origin/main <your-branch> --rows "[B1.8],[B1.11]"
```

- **Rows:** only the ones the change can move (`ROW_MAP` in the script: a file it does not list moves every tree row).
  Nothing in `packages/docnode/src` changed = nothing to measure.
- **No waiting:** it never waits for a quiet machine and never repeats a run. Each round runs BASE and NEW one after
  the other in alternating order, and the statistic uses each pair, so load that hits both cancels out.
- **Stops when it knows:** looks at 10, 20 and 40 rounds (99 %, 99 %, then 95 % intervals); a row leaves when all its
  cells are decided.
- **Same warm-up** as the full method (two passes). One pass was tried: it left code unoptimized (same tree, B1.9 save
  +129 %, B1.8 time +15 % against two passes), which changes what is measured.
- **Statistic:** mean of ln(NEW / BASE) over two-round blocks, Student t interval. Verdicts as in rule 7 (±2 %). An
  undecided cell says how far it can have moved: "no change beyond ±X %", or which way it leans.
- **Instructions too:** after the time rounds, 10 paired rounds count the thread's instructions (`FAIR_IC=1`), which do
  not move with the machine's load. A cell is "better" / "worse" / "same" only when time and instructions agree, as in
  the full method; otherwise both readings are shown. They are not perfectly clean: a young GC runs on the main
  thread, so short windows (save, ~1 ms) still vary.
- **No bytes:** they are exact; measure them once with the extra pass.
- It writes `quick-summary.json` and updates `out/measured.json`: per row and column the date, commits, mode, rounds,
  interval, spread and load. The artifact's "updated" column reads that file.

What it gives (2026-11-28, Apple M3 Pro, another VM keeping the load at 6–8; trial with one warm-up pass and 60
rounds, 3.7 min): main against main, 8 tree rows: no cell "better" or "worse", intervals ±5–22 %. main against a
change: ±5–12 %, one cell "same". So a quick check rules out changes bigger than ~10 % on a busy machine; finer
differences need a quiet machine or the full method below. Final version (two warm-up passes, 40 rounds of time +
10 of instructions, load 5.6): 3.7 min, most cells within ±3–5 % in time and in instructions.

### Quick table against Yjs (default for the artifact's tables while a milestone is open)

```sh
node scripts/fair/quick-table.ts antes=origin/main despues=<your-branch>   # one or more <name>=<ref>
node scripts/fair/quick-table.ts despues=<your-branch> --rows "[B4],[B1.2]"
```

DocNode versions against the better of Yjs 13 and Yjs 14, with the paired statistic of the quick check: looks at 6 and
12 rounds (99 %), rows leave when decided, and bytes and stored doc from one exact pass. Rows run in two groups,
because every subject of a process must run the same rows (they share one seeded random generator, and the harness
stops at the first row a subject cannot run): text rows (B1.1–B1.7, B2.1–B2.4, B3.5, B4) with the versions that have
`text()`, tree rows (B1.8–B1.11, B3.1–B3.4) with all of them. It writes `summary.json` and `table.html` (the
artifact's table, with an "updated" note per row). Most of its time is Yjs 14 in B4 (~9 s per pass, three passes per
process): 21 rows took ~15 min on 2026-11-28.

### Full method: important changes, when asked, and to close a milestone (~25–60 min)

Run it for an important change (when the owner asks for it) and when a milestone closes, for the artifact's tables.
It runs the whole method (rules 4, 6, 7, 10 and 11) and prints only verdicts, with the % (ratio of means) next to
"better" or "worse" only. It waits for a quiet machine and repeats busy runs, so on a shared machine it can end with
"no verdict: busy machine" (2026-11-28: run B was busy three times).

```sh
git worktree add --detach trees/base origin/main
git worktree add --detach trees/new <your-branch>
node scripts/fair/docnode-compare.ts trees/base trees/new           # writes out/docnode-compare/
node scripts/fair/docnode-compare.ts trees/base trees/new --smoke   # 5 rounds: only names cells that may have changed
```

`--smoke` prints no numbers on purpose. Short runs move with GC and JIT timing: on 2026-11-27 a 3-round run showed a
B3.2 time of +125 % (+38 % instructions) that was only a young GC landing inside the 2–5 ms window, and it vanished
with a bigger young heap. Before each run the command waits for the load average to drop under `QUIET_LOAD` (4).

### Measure the best Yjs + the current DocNode + a candidate

Both Yjs versions always run; each cell uses the better one as the reference. A DocNode subject is a DocuKit checkout
in `trees/<name>`, bundled with the crdt-benchmarks adapter into `bundles/<name>.mjs`.

```sh
git worktree add --detach trees/current origin/main
git worktree add --detach trees/candidate <your-branch>
node scripts/build.ts trees/current scripts/docnodeAdapter.ts bundles/current.mjs
node scripts/build.ts trees/candidate scripts/docnodeAdapter.ts bundles/candidate.mjs

export SUBJECTS=yjs13,yjs14,current,candidate BASE=current NEW=candidate OUT_DIR=$PWD/out/candidate
node scripts/fair/all.ts                       # official runs A + B, GC pass, bytes, instructions, statistics (~20 min)
node scripts/fair/docs-all.ts                  # app-shaped documents (~2 min)
node scripts/fair/ic-compare.ts "$OUT_DIR"     # candidate against current: time and instructions
node scripts/fair/report.ts "$OUT_DIR"         # writes $OUT_DIR/report.md
git worktree remove trees/current && git worktree remove trees/candidate
```

The plan, in order (`all.ts` steps `runs,gc,extra,ic,compare`, one process at a time):

| Phase                  | What                                                                  | Decides?                 |
| ---------------------- | --------------------------------------------------------------------- | ------------------------ |
| official runs (`runs`) | Runs A and B, 30 rounds each, Kevin rows and G1.8/G1.9, `FAIR_GC` off | yes (timed columns, mem) |
| GC diagnostics (`gc`)  | 30 rounds with `FAIR_GC=1`, same rows and subjects                    | no: qualifies (rule 13)  |
| bytes (`extra`)        | 5 + 5 rounds, one row per process                                     | yes (bytes columns)      |
| instructions (`ic`)    | BASE and NEW only, 15 + 15 rounds, B1 rows                            | DocNode vs DocNode only  |
| statistics (`compare`) | `fair-summary.json`                                                   | —                        |
| docs (`docs-all.ts`)   | App-shaped documents, 15 + 15 rounds, plus their instruction pass     | yes                      |

`report.ts` prints the wall time of every phase (`wall.json`) and the total. Other variables: `ROUNDS` (30),
`GC_ROUNDS` (30), `EXTRA_ROUNDS` (5), `IC_ROUNDS` (15), `W` (work folder, default this folder). `node
scripts/fair/all.ts compare` only recomputes the statistics.

**Confirmation** (only for cells that need it, never automatic; run `compare` and `report.ts` again afterwards):

```sh
CONFIRM="B1.11:save,G1.9:time" node scripts/fair/all.ts confirm,compare   # 60 + 60 rounds (CONFIRM_ROUNDS), 97.5 % intervals
node scripts/fair/all.ts heap2,compare                                     # second heap history, 30 + 30 rounds (~10 min)
```

Columns for `CONFIRM`: `loadNoGc`, `time`, `save`. The confirmation run decides the named cells on its own; the report
shows both. The second history repeats runs A and B with `--import scripts/fair/heap-preload.ts`; the report shows
both histories and the cross-history outcome.

### Diagnostics

```sh
FAIR_GC=1 node --expose-gc scripts/fair/child.ts time candidate "[B1.8]" out/gc.json      # GC pauses and allocated bytes per window
WARM=10 MEAS=10 node --expose-gc scripts/fair/warm-pilot.ts candidate "[B1.8],[B1.9]" out/warm.json   # warm vs first run
node scripts/fair/gc-onoff.ts candidate out/gc-onoff.json     # does FAIR_GC=1 move the windows? (finding 8)
```

### Output files (in `OUT_DIR`)

| File                                          | What it holds                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `kevin-A.json`, `kevin-B.json`, `g-A/B.json`  | Raw samples of every window, the load average of every process and the Node version |
| `kevin-gc.json`, `g-gc.json`                  | GC diagnostics pass (`FAIR_GC=1`)                                                   |
| `kevin-xA/xB.json`, `g-xA/xB.json`            | Bytes pass                                                                          |
| `ic-A/B.json`, `docs-ic-A/B.json`             | Instruction counts (BASE and NEW only)                                              |
| `confirm-*.json`, `confirm.json`, `h2-*.json` | Confirmation runs and second heap history (only when run)                           |
| `fair-summary.json`, `fair-docs-summary.json` | Per cell: mean, median, %, pooled interval, A and B, both Yjs, outcome, flags, GC   |
| `fair-ic-summary.json`                        | NEW against BASE: time outcome, instruction outcome, judgement                      |
| `wall.json`                                   | Wall time of every phase                                                            |
| `report.md`                                   | All of the above as tables                                                          |

## Folder layout

| Path                                                 | What it is                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                           | Downloads crdt-benchmarks, builds `cb/js-lib-fair` and the extra Yjs factories from the patches, installs dependencies. Safe to run again.                                                                                          |
| `harness/js-lib-fair.patch`                          | Upstream `js-lib` → fair copy: exact windows (`<column> exact`), `loadNoGc`, `FAIR_IC` (instructions), `FAIR_GC` (GC pauses, allocated bytes), 2 decimals. Upstream columns keep their meaning.                                     |
| `harness/yjs13-xml-factory.patch`                    | Upstream Yjs 13 factory → one `Y.XmlElement` per number (G1.8, G1.9).                                                                                                                                                               |
| `harness/yjs14/`                                     | Yjs 14 (`@y/y` 14.0.0-rc.29) factory, which upstream does not have, with its lockfile. Plain JS on purpose (see its header).                                                                                                        |
| `harness/yjs14-node-factory.patch`                   | Yjs 14 factory → one `Y.Node` per number (G1.8, G1.9).                                                                                                                                                                              |
| `scripts/docnodeAdapter.ts`                          | DocNode adapter for the harness (Base mode). The harness is the network; a module-level counter is the server order; a replica with pending updates rebases on a foreign one. `pending` keeps the update bytes, not the operations. |
| `scripts/build.ts`, `build-lib.ts`                   | Bundle a DocNode tree (or a prebuilt library bundle) with the adapter.                                                                                                                                                              |
| `scripts/fair/all.ts`, `run.ts`, `child.ts`          | Orchestrator, runner (one process per library and round, load check, exit code 3 = repeat) and the measured process (adds `memFair`, `memFairWarm`; bytes mode).                                                                    |
| `scripts/fair/stats.ts`, `compare.ts`                | The fixed statistics and the per-cell summary (with the GC diagnostics, confirmation and second history).                                                                                                                           |
| `scripts/fair/heap-preload.ts`, `gc-onoff.ts`        | The second heap history (16 MB of short-lived garbage at start, `--import`); the one-time FAIR_GC on/off check.                                                                                                                     |
| `scripts/fair/wall.ts`                               | Wall time per phase (`wall.json`).                                                                                                                                                                                                  |
| `scripts/fair/docs*.ts`, `build-docs.ts`             | App-shaped documents probe (DocNode and Yjs build the same seeded content) and its statistics.                                                                                                                                      |
| `scripts/fair/ic-compare.ts`, `icount.ts`            | DocNode against DocNode with instructions; the thread instruction counter.                                                                                                                                                          |
| `scripts/fair/docnode-compare.ts`                    | DocNode against DocNode, end to end: bundles, runs, instructions, statistics, verdicts only.                                                                                                                                        |
| `scripts/fair/quick-compare.ts`                      | Quick check, the default: rows from the changed files, paired rounds without waiting, stops when it knows.                                                                                                                          |
| `scripts/fair/report.ts`, `warm-pilot.ts`            | Markdown report; warm-up pilot.                                                                                                                                                                                                     |
| `cb/`, `deps/`, `trees/`, `bundles/`, `out/`, `tmp/` | Work folders, git-ignored. Never commit raw output or bundles.                                                                                                                                                                      |

### Not checked by the repo tools

The folder is excluded from the root `tsc`, ESLint and Knip. The scripts are research code: they use `any` for the
JSON they pass around and for the adapter (which must work across DocNode trees with different APIs), and they need
Node 26-only APIs (`node:ffi`). Prettier still formats them, except `harness/` (kept in upstream style so the
patches apply). Milestone 4 should type them before they become part of CI (see the last section).

## Findings

Findings 1–7 were measured with the earlier rule (median, win / loss / tie, A and B had to agree); finding 8 with
the current one.

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
| GC share of the whole row                     | 13–31 % for DocNode, 2–3 % for Yjs. No GC pause fell inside load windows; one fell inside B1.11 save in every round for c140 (rule 7).                                                                                   |
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

### 8. FAIR_GC on and off (one-time check, 2026-11-27)

`gc-onoff.ts despues`: rows B1.8–B1.11, 30 rounds with `FAIR_GC=0` and 30 with `FAIR_GC=1`, interleaved, alternating
order, one process at a time (load > 6 in 8 % of the processes). % = on / off − 1, 95 % interval (rule 7, one run).

| Row   | load                 | time                 | save                 |
| ----- | -------------------- | -------------------- | -------------------- |
| B1.8  | −3.9 % [−9.9, +1.5]  | +2.4 % [−1.9, +6.7]  | +4.8 % [−1.6, +13.3] |
| B1.9  | −2.0 % [−6.2, +1.7]  | −1.6 % [−3.8, +0.4]  | −2.2 % [−7.5, +3.0]  |
| B1.10 | +4.2 % [−6.3, +18.6] | −2.2 % [−5.3, +0.7]  | −0.7 % [−5.8, +3.3]  |
| B1.11 | −1.3 % [−6.1, +2.7]  | +1.2 % [−7.9, +11.9] | +8.2 % [−5.8, +18.9] |

All 12 cells are inconclusive: no window moved beyond ±2 %, but none is shown equivalent either (B1.11 save: 3.005 ms
off, 3.253 ms on). With `FAIR_GC=1` the pause shares matched the official harness check: 0/30 in every load, 30/30 in
B1.11 save. So the GC pass describes the same process only approximately, and **we do not claim that pauses land in the
same place with FAIR_GC off**. That is why the GC pass qualifies outcomes and never decides them.

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
3. **Time guardrails: candidate against `main` in the same job**, with rules 4, 6 and 7 (interleaved rounds, A/B
   drift check, interval beyond ±2 %). Hosted runners are noisier than this Mac, so start with a report, not a failing check,
   and tune the band from real CI data.
4. **An instruction counter for Linux** (`perf_event_open`, or `perf stat` where the runner exposes hardware
   counters; GitHub-hosted VMs usually do not). Otherwise consider Valgrind/cachegrind for a deterministic count.
5. **Catch the B1.11 coin** (finding 5): split instruction counts by mode or add the "B1.11 alone" control.
6. **Keep raw output as CI artifacts** (`out/`), never in git, and keep the report short: the verdict columns, with
   Kevin's load next to it.

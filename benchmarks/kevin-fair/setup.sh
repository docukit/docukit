#!/usr/bin/env bash
# Prepares the git-ignored work folders next to this script:
#   cb/    crdt-benchmarks pinned at 796f7025 + the fair harness copy (cb/js-lib-fair) + the extra Yjs factories
#   deps/  esbuild (bundles a DocNode tree with the adapter) and ulid (DocNode's runtime dependency)
# Safe to run again: it rebuilds cb/js-lib-fair and the factories, and keeps what is already installed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PIN=796f70250c8c003dfb3a50369d0b2733a760e54d
CB="$HERE/cb"
# npm 11 rejects the upstream lockfile ("Missing: fsevents@2.3.3 from lock file"); npm 10 installs it as it is.
NPM=(npx -y npm@10.9.2)

if [ ! -f "$CB/js-lib/index.js" ]; then
  mkdir -p "$CB"
  curl -fsSL "https://codeload.github.com/dmonad/crdt-benchmarks/tar.gz/$PIN" | tar -xz -C "$CB" --strip-components=1
fi
[ -d "$CB/node_modules" ] || (cd "$CB" && "${NPM[@]}" ci --ignore-scripts --no-audit --no-fund)

# Fair harness: a copy of upstream js-lib plus harness/js-lib-fair.patch. The editing trace must be the SAME module
# as upstream's (a symlink): the Yjs 13 factory imports ../../js-lib/index.js, and a second copy of the 29 MB trace
# in the heap makes every forced GC slower (Yjs 13 "load" in B1.8 went from 30.9 to 63.3 ms).
rm -rf "$CB/js-lib-fair"
mkdir "$CB/js-lib-fair"
for f in "$CB"/js-lib/*.js; do
  [ "$(basename "$f")" = b4-editing-trace.js ] || cp "$f" "$CB/js-lib-fair/"
done
(cd "$CB/js-lib-fair" && patch -s -p1 --no-backup-if-mismatch < "$HERE/harness/js-lib-fair.patch")
ln -s ../js-lib/b4-editing-trace.js "$CB/js-lib-fair/b4-editing-trace.js"

# Yjs 13 with one XmlElement per number (row G1.9).
cp "$CB/benchmarks/yjs/factory.js" "$CB/benchmarks/yjs/factory-xml.js"
patch -s --no-backup-if-mismatch "$CB/benchmarks/yjs/factory-xml.js" < "$HERE/harness/yjs13-xml-factory.patch"

# Yjs 14 (not in upstream) and its one-Node-per-number variant (row G1.9).
mkdir -p "$CB/benchmarks/yjs14"
cp "$HERE"/harness/yjs14/{factory.js,package.json,package-lock.json} "$CB/benchmarks/yjs14/"
cp "$CB/benchmarks/yjs14/factory.js" "$CB/benchmarks/yjs14/factory-node.js"
patch -s --no-backup-if-mismatch "$CB/benchmarks/yjs14/factory-node.js" < "$HERE/harness/yjs14-node-factory.patch"
[ -d "$CB/benchmarks/yjs14/node_modules" ] || (cd "$CB/benchmarks/yjs14" && "${NPM[@]}" ci --ignore-scripts --no-audit --no-fund)

# esbuild for scripts/build.ts and scripts/fair/build-docs.ts, and DocNode's runtime dependency (ulid): a tree in
# trees/ is bundled from source and has no node_modules of its own.
[ -d "$HERE/deps/node_modules/ulid" ] || "${NPM[@]}" install --prefix "$HERE/deps" --no-save --no-audit --no-fund esbuild@0.27.2 ulid@3.0.2

mkdir -p "$HERE/bundles" "$HERE/trees" "$HERE/out" "$HERE/tmp"
echo "ready: $CB"

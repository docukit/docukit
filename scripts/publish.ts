#!/usr/bin/env node
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  appendFileSync,
  mkdtempSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Package = { name: string; version?: string; private?: boolean };
type Loaded = { dir: string; pkg: Package };

const run = (cmd: string) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
};
const captureRequired = (cmd: string, cwd = ROOT): string => {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
};
const capture = (cmd: string): string | undefined => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

function readWorkspaceGlobs(): string[] {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    let rest = trimmed.slice(1).trim();
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1);
    }
    if (rest) globs.push(rest);
  }
  return globs;
}

function expandGlobs(globs: string[]): string[] {
  const dirs = new Set<string>();
  for (const g of globs) {
    if (g.endsWith("/*")) {
      const baseDir = join(ROOT, g.slice(0, -2));
      if (!existsSync(baseDir)) continue;
      for (const entry of readdirSync(baseDir)) {
        const full = join(baseDir, entry);
        if (statSync(full).isDirectory()) dirs.add(full);
      }
    } else {
      const full = join(ROOT, g);
      if (existsSync(full) && statSync(full).isDirectory()) dirs.add(full);
    }
  }
  return [...dirs];
}

const loaded: Loaded[] = expandGlobs(readWorkspaceGlobs())
  .map((d): Loaded | undefined => {
    const p = join(d, "package.json");
    if (!existsSync(p)) return undefined;
    return { dir: d, pkg: JSON.parse(readFileSync(p, "utf8")) as Package };
  })
  .filter(
    (e): e is Loaded => e !== undefined && !e.pkg.private && !!e.pkg.version,
  );

if (loaded.length === 0) {
  console.error("✖ no publishable packages found");
  process.exit(1);
}

const packDir = mkdtempSync(join(tmpdir(), "docukit-publish-"));

const results: { published: string[]; skipped: string[]; failed: string[] } = {
  published: [],
  skipped: [],
  failed: [],
};

for (const { dir, pkg } of loaded) {
  const version = pkg.version;
  if (!version) continue;
  const spec = `${pkg.name}@${version}`;
  const isAlpha = version.includes("-alpha.");

  const existing = capture(`npm view ${spec} version 2>/dev/null`);
  if (existing === version) {
    console.log(`⊙ ${spec} already on registry — skipping`);
    results.skipped.push(spec);
    continue;
  }

  try {
    const packedPath = captureRequired(
      `pnpm pack --pack-destination ${JSON.stringify(packDir)}`,
      dir,
    );
    const tarball = resolve(dir, packedPath);
    const tagFlag = isAlpha ? " --tag latest" : "";
    run(
      `npm publish ${JSON.stringify(tarball)} --access public --provenance${tagFlag}`,
    );
    results.published.push(spec);
  } catch (err) {
    results.failed.push(spec);
    console.error(`✖ publish failed for ${spec}: ${(err as Error).message}`);
  }
}

const verifySpec = async (spec: string): Promise<string | undefined> => {
  const parts = spec.split("@");
  const expected = parts[parts.length - 1];
  const attempts = 8;
  const delayMs = 5_000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const actual = capture(`npm view ${spec} version 2>/dev/null`);
    if (actual === expected) return undefined;

    if (attempt < attempts) {
      console.log(
        `Waiting for ${spec} to appear on npm (${attempt}/${attempts})...`,
      );
      await sleep(delayMs);
    } else {
      return `${spec} (registry: ${actual ?? "not found"})`;
    }
  }

  return `${spec} (registry: not found)`;
};

const verifyFailed: string[] = [];
for (const spec of [...results.published, ...results.skipped]) {
  const failure = await verifySpec(spec);
  if (failure) verifyFailed.push(failure);
}

console.log("\n=== Publish summary ===");
console.log(`published (${results.published.length}):`);
for (const s of results.published) console.log(`  + ${s}`);
console.log(`skipped, already on registry (${results.skipped.length}):`);
for (const s of results.skipped) console.log(`  ⊙ ${s}`);
console.log(`failed (${results.failed.length}):`);
for (const s of results.failed) console.log(`  ✖ ${s}`);

if (verifyFailed.length) {
  console.error("\n✖ post-publish verification failed:");
  for (const s of verifyFailed) console.error(`  - ${s}`);
}

if (results.failed.length || verifyFailed.length) process.exit(1);

// Release tag: prefer a stable (non-alpha) version. If only alpha packages exist,
// use the full alpha version. Sort by package name for determinism.
const sorted = [...loaded].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
const stable = sorted.find((l) => !l.pkg.version?.includes("-alpha."));
const releaseVersion = (stable ?? sorted[0])?.pkg.version;
if (!releaseVersion) {
  console.error("✖ cannot derive release tag");
  process.exit(1);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=v${releaseVersion}\n`);
}
console.log(`\n✓ release tag: v${releaseVersion}`);

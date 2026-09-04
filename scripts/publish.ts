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
import { resolveReleaseTag, verifyPublishedSpecs } from "./publish-utils.ts";

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

let releaseTag: string;
try {
  const releaseCommitSubject = captureRequired(
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
      ? "git log -1 --format=%s --grep='^chore: release v'"
      : "git log -1 --pretty=%s",
  );
  releaseTag = resolveReleaseTag(
    releaseCommitSubject,
    loaded.flatMap(({ pkg }) => (pkg.version ? [pkg.version] : [])),
  );
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
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
  } catch (error) {
    results.failed.push(spec);
    console.error(
      `✖ publish failed for ${spec}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const verifyFailed = await verifyPublishedSpecs(
  [...results.published, ...results.skipped],
  {
    readVersion: (spec) => capture(`npm view ${spec} version 2>/dev/null`),
    onRetry: (spec, attempt, attempts) => {
      console.log(
        `Waiting for ${spec} to appear on npm (${attempt}/${attempts})...`,
      );
    },
  },
);

console.log("\n=== Publish summary ===");
console.log(`published (${results.published.length}):`);
for (const s of results.published) console.log(`  + ${s}`);
console.log(`skipped, already on registry (${results.skipped.length}):`);
for (const s of results.skipped) console.log(`  ⊙ ${s}`);
console.log(`failed (${results.failed.length}):`);
for (const s of results.failed) console.log(`  ✖ ${s}`);

if (verifyFailed.length) {
  console.warn("\n⚠ npm registry propagation is still pending:");
  for (const s of verifyFailed) console.warn(`  - ${s}`);
  console.warn(
    "npm accepted the publish; continuing while registry metadata propagates.",
  );
}

if (results.failed.length) process.exit(1);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${releaseTag}\n`);
}
console.log(`\n✓ release tag: ${releaseTag}`);

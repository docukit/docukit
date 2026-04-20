#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PR_TITLE = process.env.PR_TITLE ?? "";
const BASE = process.env.GITHUB_BASE_REF ?? "main";

const TITLE_RE = /^chore: release v(\d+\.\d+\.\d+(?:-alpha\.\d+)?)$/;
const CHANGELOG_RE = /^changelog\/v(\d+\.\d+\.\d+(?:-alpha\.\d+)?)\.md$/;
const PKG_RE = /^packages\/[^/]+\/package\.json$/;
const VERSION_LINE_RE = /^[+-]\s*"version"\s*:\s*"[^"]+",?\s*$/;
const VERSION_FIELD_RE = /"version"\s*:\s*"([^"]+)"/;

const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

type DiffEntry = { status: string; path: string };

const titleVersion =
  TITLE_RE.exec(PR_TITLE)?.[1] ??
  fail(
    `PR title "${PR_TITLE}" must match:  chore: release vX.Y.Z  or  chore: release vX.Y.Z-alpha.N`,
  );

const diffRaw = execSync(`git diff --name-status origin/${BASE}...HEAD`, {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

if (!diffRaw) {
  fail(
    "no changes vs base — a release PR must bump versions and add a changelog.",
  );
}

const entries: DiffEntry[] = [];
for (const line of diffRaw.split("\n")) {
  const [status, ...pathParts] = line.split("\t");
  if (!status || pathParts.length === 0) continue;
  entries.push({ status, path: pathParts.join("\t") });
}

let changelogFound: string | undefined;
const packageJsonsChanged: string[] = [];
const errors: string[] = [];

for (const { status, path } of entries) {
  if (path.endsWith("_DISCORD.md")) {
    errors.push(`Discord file must not be committed: ${path}`);
    continue;
  }

  if (CHANGELOG_RE.exec(path)) {
    if (status !== "A") {
      errors.push(
        `changelog file must be newly added (status=${status}): ${path}`,
      );
      continue;
    }
    if (changelogFound) {
      errors.push(
        `only one new changelog file allowed; also found ${changelogFound}`,
      );
      continue;
    }
    changelogFound = path;
    continue;
  }

  if (PKG_RE.test(path)) {
    if (status !== "M") {
      errors.push(
        `${path} must be modified (not added/removed); got status=${status}`,
      );
      continue;
    }
    const pkgDiff = execSync(`git diff origin/${BASE}...HEAD -- "${path}"`, {
      cwd: ROOT,
      encoding: "utf8",
    });
    for (const line of pkgDiff.split("\n")) {
      if (!line.startsWith("+") && !line.startsWith("-")) continue;
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (!VERSION_LINE_RE.test(line)) {
        errors.push(`${path}: non-version change detected: ${line.trim()}`);
        break;
      }
    }
    packageJsonsChanged.push(path);
    continue;
  }

  errors.push(
    `unexpected file change: ${path} (status=${status}) — release PRs may only change packages/*/package.json versions and add one changelog file.`,
  );
}

if (!changelogFound) {
  errors.push(
    `missing changelog file (expected: changelog/v${titleVersion}.md)`,
  );
}
if (packageJsonsChanged.length === 0) {
  errors.push(
    "no package.json version bumps found — the PR must bump at least one version.",
  );
}

if (changelogFound) {
  const cm = CHANGELOG_RE.exec(changelogFound);
  if (cm?.[1] && cm[1] !== titleVersion) {
    errors.push(
      `PR title version v${titleVersion} does not match changelog file v${cm[1]}`,
    );
  }
}

// The bumped versions must include the PR-title version as-is (alpha-for-alpha, stable-for-stable).
const bumpedVersions = new Set<string>();
for (const p of packageJsonsChanged) {
  const content = readFileSync(join(ROOT, p), "utf8");
  const v = VERSION_FIELD_RE.exec(content)?.[1];
  if (!v) {
    errors.push(`${p}: could not read version`);
    continue;
  }
  bumpedVersions.add(v);
}
if (packageJsonsChanged.length && !bumpedVersions.has(titleVersion)) {
  errors.push(
    `no package.json bumped to v${titleVersion}; versions in diff are: ${[...bumpedVersions].join(", ")}`,
  );
}

if (errors.length) {
  fail(`release PR validation failed:\n  - ${errors.join("\n  - ")}`);
}

console.log(`✓ Release PR valid for v${titleVersion}`);
console.log(`  - ${packageJsonsChanged.length} package.json(s) bumped`);
console.log(`  - changelog: ${changelogFound}`);

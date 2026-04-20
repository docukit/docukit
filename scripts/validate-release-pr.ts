#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PR_TITLE = process.env.PR_TITLE ?? "";
const BASE = process.env.GITHUB_BASE_REF || "main";

const TITLE_RE = /^chore: release v(\d+\.\d+\.\d+(?:-alpha\.\d+)?)$/;
const CHANGELOG_RE = /^changelog\/v(\d+\.\d+\.\d+(?:-alpha\.\d+)?)\.md$/;
const PKG_RE = /^(packages\/[^/]+|docs|examples)\/package\.json$/;

const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

type DiffEntry = { status: string; path: string };

const titleMatch = PR_TITLE.match(TITLE_RE);
if (!titleMatch) {
  fail(
    `PR title "${PR_TITLE}" must match:  chore: release vX.Y.Z  or  chore: release vX.Y.Z-alpha.N`,
  );
}
const titleVersion = titleMatch![1];

const diffRaw = execSync(`git diff --name-status origin/${BASE}...HEAD`, {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

if (!diffRaw) {
  fail(
    "no changes vs base — a release PR must bump versions and add a changelog.",
  );
}

const entries: DiffEntry[] = diffRaw.split("\n").map((line) => {
  const [status, ...pathParts] = line.split(/\s+/);
  return { status, path: pathParts.join(" ") };
});

let changelogFound: string | null = null;
const packageJsonsChanged: string[] = [];
const errors: string[] = [];

for (const { status, path } of entries) {
  if (path.endsWith("_DISCORD.md")) {
    errors.push(`Discord file must not be committed: ${path}`);
    continue;
  }

  const cm = path.match(CHANGELOG_RE);
  if (cm) {
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
      if (!/^[+-]\s*"version"\s*:\s*"[^"]+",?\s*$/.test(line)) {
        errors.push(`${path}: non-version change detected: ${line.trim()}`);
        break;
      }
    }
    packageJsonsChanged.push(path);
    continue;
  }

  errors.push(
    `unexpected file change: ${path} (status=${status}) — release PRs may only change package.json versions and add one changelog file.`,
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
  const cv = changelogFound.match(CHANGELOG_RE)![1];
  if (cv !== titleVersion) {
    errors.push(
      `PR title version v${titleVersion} does not match changelog file v${cv}`,
    );
  }
}

// The bumped versions must include the PR-title version as-is (alpha-for-alpha, stable-for-stable).
const bumpedVersions = new Set<string>();
for (const p of packageJsonsChanged) {
  const content = readFileSync(join(ROOT, p), "utf8");
  const vm = content.match(/"version"\s*:\s*"([^"]+)"/);
  if (!vm) {
    errors.push(`${p}: could not read version`);
    continue;
  }
  bumpedVersions.add(vm[1]);
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

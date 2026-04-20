#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Version = {
  major: number;
  minor: number;
  patch: number;
  alpha: number | null;
};
type Package = { name: string; version?: string; private?: boolean };
type Loaded = { dir: string; pkgPath: string; raw: string; pkg: Package };
type DistTags = { latest?: string; alpha?: string } | null;
type Mode = "stable" | "alpha";
type Kind = "major" | "minor" | "patch";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (q: string): Promise<string> =>
  new Promise((r) => rl.question(q, r));
const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  rl.close();
  process.exit(1);
};
const info = (msg: string) => console.log(msg);

function readWorkspaceGlobs(): string[] {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  for (const line of yaml.split("\n")) {
    const m = line.match(/^\s*-\s*["']?([^"']+?)["']?\s*$/);
    if (m) globs.push(m[1]);
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

function loadPackage(dir: string): Loaded | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const raw = readFileSync(pkgPath, "utf8");
  return { dir, pkgPath, raw, pkg: JSON.parse(raw) };
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;
function parseVersion(v: string | undefined): Version | null {
  const m = v?.match(VERSION_RE);
  return m
    ? {
        major: +m[1],
        minor: +m[2],
        patch: +m[3],
        alpha: m[4] == null ? null : +m[4],
      }
    : null;
}
function formatVersion(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.alpha == null ? base : `${base}-alpha.${v.alpha}`;
}
const isAlpha = (pkg: Package) => !!pkg.version?.includes("-alpha.");
const isPublishable = (pkg: Package) => !pkg.private && !!pkg.version;

function assertCleanTree() {
  const dirty = execSync("git status --porcelain", {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    fail(
      `working tree is not clean — commit or stash changes before bumping.\nUncommitted:\n${dirty}`,
    );
  }
}

function assertVersionConsistency(pkgs: Loaded[]) {
  const groups = new Map<string, string[]>();
  for (const { pkg } of pkgs) {
    const parsed = parseVersion(pkg.version);
    if (!parsed) fail(`${pkg.name} has invalid version "${pkg.version}"`);
    const key = `${parsed!.major}.${parsed!.minor}.${parsed!.patch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pkg.name);
  }
  if (groups.size > 1) {
    const lines = [...groups.entries()].map(
      ([k, v]) => `  ${k}: ${v.join(", ")}`,
    );
    fail(
      `publishable packages disagree on major.minor.patch — fix before bumping:\n${lines.join("\n")}`,
    );
  }
}

function queryNpmDistTags(name: string): DistTags {
  try {
    const out = execSync(`npm view ${name} dist-tags --json 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

function bumpStable(parsed: Version, kind: Kind): Version {
  if (kind === "major")
    return { major: parsed.major + 1, minor: 0, patch: 0, alpha: null };
  if (kind === "minor")
    return {
      major: parsed.major,
      minor: parsed.minor + 1,
      patch: 0,
      alpha: null,
    };
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch + 1,
    alpha: null,
  };
}

function applyBump(
  parsed: Version,
  mode: Mode,
  kind: Kind | null,
  wasAlpha: boolean,
): Version {
  if (mode === "stable") {
    const next = bumpStable(parsed, kind!);
    if (wasAlpha) next.alpha = 1;
    return next;
  }
  if (parsed.alpha == null)
    throw new Error("cannot alpha-bump a non-alpha package");
  return { ...parsed, alpha: parsed.alpha + 1 };
}

type GuardResult = { ok: true } | { ok: false; reason: string };
function guardrail(
  publishedVersion: string,
  proposed: Version,
  mode: Mode,
  kind: Kind | null,
  wasAlpha: boolean,
): GuardResult {
  const published = parseVersion(publishedVersion);
  if (!published)
    return {
      ok: false,
      reason: `published version "${publishedVersion}" is unparseable`,
    };
  const expected = applyBump(published, mode, kind, wasAlpha);
  const proposedStr = formatVersion(proposed);
  const expectedStr = formatVersion(expected);
  if (proposedStr !== expectedStr) {
    return {
      ok: false,
      reason: `proposed=${proposedStr} but expected=${expectedStr} (published: ${publishedVersion})`,
    };
  }
  return { ok: true };
}

type PlanEntry = Loaded & {
  parsed: Version;
  next: Version;
  status: "ok" | "first-publish" | "warning";
  publishedVersion: string | null;
};

(async () => {
  info("DocuKit release bump\n");

  info("• Checking working tree...");
  assertCleanTree();

  info("• Scanning workspace packages...");
  const dirs = expandGlobs(readWorkspaceGlobs());
  const loaded = dirs.map(loadPackage).filter((e): e is Loaded => e != null);
  const publishable = loaded.filter(({ pkg }) => isPublishable(pkg));
  if (publishable.length === 0) fail("no publishable packages found.");

  info("• Asserting version consistency...");
  assertVersionConsistency(publishable);

  info("• Querying npm registry...");
  const distTags: Record<string, DistTags> = {};
  for (const { pkg } of publishable) {
    distTags[pkg.name] = queryNpmDistTags(pkg.name);
  }

  const alphaPkgs = publishable.filter(({ pkg }) => isAlpha(pkg));

  info("\nPublishable packages:");
  for (const { pkg } of publishable) {
    const tagged = isAlpha(pkg) ? " [alpha]" : "";
    const tags = distTags[pkg.name];
    const registry = tags
      ? `latest=${tags.latest ?? "-"} alpha=${tags.alpha ?? "-"}`
      : "never published";
    info(`  ${pkg.name}@${pkg.version}${tagged}  (registry: ${registry})`);
  }

  info("\nBump mode:");
  info(
    "  (a) Stable — bumps ALL publishable packages (alpha counter resets to 1)",
  );
  info("  (b) Alpha — bumps alpha packages only (alpha.N → alpha.N+1)");
  const modeAns = (await ask("Pick (a/b): ")).trim().toLowerCase();
  const mode: Mode | null =
    modeAns === "a" || modeAns === "stable"
      ? "stable"
      : modeAns === "b" || modeAns === "alpha"
        ? "alpha"
        : null;
  if (!mode) fail(`unknown mode "${modeAns}"`);

  let kind: Kind | null = null;
  if (mode === "stable") {
    const k = (await ask("  major | minor | patch: ")).trim().toLowerCase();
    if (!["major", "minor", "patch"].includes(k)) fail(`unknown kind "${k}"`);
    kind = k as Kind;
  } else {
    if (alphaPkgs.length === 0) fail("no alpha packages to bump.");
    info(
      "\n⚠  In this monorepo, alpha packages publish with BOTH `alpha` and `latest` dist-tags.",
    );
    info(
      "   After publish, `npm install @docukit/<pkg>` (no tag) will return the new alpha.",
    );
    info("   Only proceed if that is intended.");
    const conf = (await ask('Type "yes" to continue: ')).trim();
    if (conf !== "yes") fail("aborted.");
  }

  const targets = mode === "alpha" ? alphaPkgs : publishable;
  const plan: PlanEntry[] = [];
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  for (const entry of targets) {
    const parsed = parseVersion(entry.pkg.version)!;
    const wasAlpha = isAlpha(entry.pkg);
    const next = applyBump(parsed, mode!, kind, wasAlpha);
    const tag = mode === "alpha" ? "alpha" : wasAlpha ? "alpha" : "latest";
    const publishedVersion = distTags[entry.pkg.name]?.[tag] ?? null;

    let status: PlanEntry["status"] = "ok";
    if (!publishedVersion) {
      status = "first-publish";
    } else if (formatVersion(next) === publishedVersion) {
      status = "warning";
      hardErrors.push(
        `${entry.pkg.name}: proposed ${formatVersion(next)} is ALREADY on the registry`,
      );
    } else {
      const g = guardrail(publishedVersion, next, mode!, kind, wasAlpha);
      if (!g.ok) {
        status = "warning";
        warnings.push(`${entry.pkg.name}: ${g.reason}`);
      }
    }
    plan.push({ ...entry, parsed, next, status, publishedVersion });
  }

  if (hardErrors.length) {
    fail(
      "cannot bump — the proposed version is already on the registry:\n  " +
        hardErrors.join("\n  "),
    );
  }

  info("\nProposed bumps:");
  for (const p of plan) {
    const badge =
      p.status === "first-publish"
        ? " [FIRST PUBLISH]"
        : p.status === "warning"
          ? " [UNUSUAL — see warnings below]"
          : "";
    const pub = p.publishedVersion ?? "(unpublished)";
    info(
      `  ${p.pkg.name}  ${formatVersion(p.parsed)}  →  ${formatVersion(p.next)}  (registry: ${pub})${badge}`,
    );
  }

  if (warnings.length) {
    info(
      "\n⚠  Unusual bump — local versions are not exactly +1 from the registry:",
    );
    for (const w of warnings) info(`     ${w}`);
    info(
      "   This usually means a previous release was bumped locally but never published.",
    );
    info(
      "   The publish workflow is idempotent — the simplest fix is to publish the pending",
    );
    info(
      "   release first (re-run the workflow) rather than stacking another bump.",
    );
    const ok = (await ask("\nContinue with this bump anyway? [y/N]: "))
      .trim()
      .toLowerCase();
    if (ok !== "y" && ok !== "yes") fail("aborted.");
  }

  const conf = (await ask("\nWrite these changes? [y/N]: "))
    .trim()
    .toLowerCase();
  if (conf !== "y" && conf !== "yes") fail("aborted.");
  rl.close();

  for (const p of plan) {
    const newV = formatVersion(p.next);
    const updated = p.raw.replace(
      /("version"\s*:\s*")[^"]+(")/,
      (_m, a, b) => `${a}${newV}${b}`,
    );
    writeFileSync(p.pkgPath, updated);
  }

  // Release tag: prefer stable (non-alpha) versions. If all bumps are alpha-only, include -alpha.N.
  const stableEntry = plan.find((p) => p.next.alpha == null);
  const releaseStr = stableEntry
    ? `v${stableEntry.next.major}.${stableEntry.next.minor}.${stableEntry.next.patch}`
    : `v${formatVersion(plan[0].next)}`;

  info(`\n✓ Bumped ${plan.length} package(s).\n`);
  info("Next steps:");
  info(
    `  Return to the /release skill session — it will verify, draft the changelog,`,
  );
  info(`  and handle commit + push + PR for release ${releaseStr}.`);
  info(
    `  (If not using /release: run /release to orchestrate, or do it manually:`,
  );
  info(
    `   commit as "chore: release ${releaseStr}", open a PR with that title, squash-merge.)\n`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

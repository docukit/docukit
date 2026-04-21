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
import {
  intro,
  outro,
  select,
  confirm,
  note,
  log,
  cancel,
  isCancel,
  spinner,
} from "@clack/prompts";
import pc from "picocolors";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Version = {
  major: number;
  minor: number;
  patch: number;
  alpha: number | undefined;
};
type Package = { name: string; version?: string; private?: boolean };
type Loaded = { dir: string; pkgPath: string; raw: string; pkg: Package };
type DistTags = { latest?: string; alpha?: string };
type Mode = "stable" | "alpha";
type Kind = "major" | "minor" | "patch";

const abort = (msg: string): never => {
  cancel(msg);
  process.exit(1);
};
const unwrap = <T>(value: T | symbol, msg = "Cancelled."): T => {
  if (isCancel(value)) abort(msg);
  return value as T;
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

function loadPackage(dir: string): Loaded | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as Package;
  return { dir, pkgPath, raw, pkg };
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;
function parseVersion(v: string | undefined): Version | undefined {
  if (v === undefined) return undefined;
  const m = VERSION_RE.exec(v);
  if (!m) return undefined;
  const [, major, minor, patch, alpha] = m;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: +major,
    minor: +minor,
    patch: +patch,
    alpha: alpha === undefined ? undefined : +alpha,
  };
}
function formatVersion(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.alpha === undefined ? base : `${base}-alpha.${v.alpha}`;
}
const compareBase = (a: Version, b: Version): number => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
};
const isAlpha = (pkg: Package) => !!pkg.version?.includes("-alpha.");
const isPublishable = (pkg: Package) => !pkg.private && !!pkg.version;

function assertCleanTree() {
  const dirty = execSync("git status --porcelain", {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    abort(
      `Working tree is not clean — commit or stash changes before bumping.\n${dirty}`,
    );
  }
}

function assertVersionConsistency(pkgs: Loaded[]) {
  const groups = new Map<string, string[]>();
  for (const { pkg } of pkgs) {
    const parsed =
      parseVersion(pkg.version) ??
      abort(`${pkg.name} has invalid version "${pkg.version}"`);
    const key = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    const arr = groups.get(key) ?? [];
    arr.push(pkg.name);
    groups.set(key, arr);
  }
  if (groups.size > 1) {
    const lines = [...groups.entries()].map(
      ([k, v]) => `  ${k}: ${v.join(", ")}`,
    );
    abort(
      `Publishable packages disagree on major.minor.patch:\n${lines.join("\n")}`,
    );
  }
}

function queryNpmDistTags(name: string): DistTags | undefined {
  try {
    const out = execSync(`npm view ${name} dist-tags --json 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    return out ? (JSON.parse(out) as DistTags) : undefined;
  } catch {
    return undefined;
  }
}

function bumpStable(parsed: Version, kind: Kind): Version {
  if (kind === "major")
    return { major: parsed.major + 1, minor: 0, patch: 0, alpha: undefined };
  if (kind === "minor")
    return {
      major: parsed.major,
      minor: parsed.minor + 1,
      patch: 0,
      alpha: undefined,
    };
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch + 1,
    alpha: undefined,
  };
}

function applyBump(
  parsed: Version,
  mode: Mode,
  kind: Kind | undefined,
  wasAlpha: boolean,
): Version {
  if (mode === "stable") {
    if (!kind) throw new Error("stable bump requires kind");
    const next = bumpStable(parsed, kind);
    if (wasAlpha) next.alpha = 1;
    return next;
  }
  if (parsed.alpha === undefined)
    throw new Error("cannot alpha-bump a non-alpha package");
  return { ...parsed, alpha: parsed.alpha + 1 };
}

type GuardResult = { ok: true } | { ok: false; reason: string };
function guardrail(
  publishedVersion: string,
  local: Version,
  proposed: Version,
  mode: Mode,
  kind: Kind | undefined,
  wasAlpha: boolean,
): GuardResult {
  const published = parseVersion(publishedVersion);
  if (!published)
    return {
      ok: false,
      reason: `published version "${publishedVersion}" is unparseable`,
    };

  if (mode === "alpha") {
    // Local base is ahead of the registry (pending unpublished stable bump).
    // The first alpha on this new base is legitimate — accept it.
    if (compareBase(local, published) > 0) return { ok: true };
    // Same base: proposed.alpha must be exactly published.alpha + 1.
    if (published.alpha === undefined) return { ok: true };
    if (proposed.alpha !== published.alpha + 1) {
      return {
        ok: false,
        reason: `proposed=${formatVersion(proposed)} but expected=${formatVersion({ ...local, alpha: published.alpha + 1 })} (published alpha: ${publishedVersion})`,
      };
    }
    return { ok: true };
  }

  const expected = applyBump(published, mode, kind, wasAlpha);
  if (formatVersion(proposed) !== formatVersion(expected)) {
    return {
      ok: false,
      reason: `proposed=${formatVersion(proposed)} but expected=${formatVersion(expected)} (published: ${publishedVersion})`,
    };
  }
  return { ok: true };
}

type PlanEntry = Loaded & {
  parsed: Version;
  next: Version;
  status: "ok" | "first-publish" | "warning";
  publishedVersion: string | undefined;
};

(async () => {
  intro(pc.bold(pc.cyan("DocuKit release bump")));

  const s = spinner();
  s.start("Checking working tree and registry");
  assertCleanTree();
  const dirs = expandGlobs(readWorkspaceGlobs());
  const loaded = dirs
    .map(loadPackage)
    .filter((e): e is Loaded => e !== undefined);
  const publishable = loaded.filter(({ pkg }) => isPublishable(pkg));
  if (publishable.length === 0) {
    s.stop("No publishable packages found");
    abort("No publishable packages found.");
  }
  assertVersionConsistency(publishable);
  const distTags: Record<string, DistTags | undefined> = {};
  for (const { pkg } of publishable) {
    distTags[pkg.name] = queryNpmDistTags(pkg.name);
  }
  s.stop(`Scanned ${publishable.length} publishable package(s)`);

  const alphaPkgs = publishable.filter(({ pkg }) => isAlpha(pkg));

  const pkgLines = publishable.map(({ pkg }) => {
    const tags = distTags[pkg.name];
    const tagged = isAlpha(pkg) ? pc.yellow(" [alpha]") : "";
    const registry = tags
      ? pc.dim(`latest=${tags.latest ?? "—"}  alpha=${tags.alpha ?? "—"}`)
      : pc.dim("never published");
    return `${pc.bold(pkg.name)}${pc.dim("@")}${pkg.version}${tagged}\n  ${registry}`;
  });
  note(pkgLines.join("\n"), "Publishable packages");

  const mode = unwrap(
    await select<Mode>({
      message: "Bump mode",
      options: [
        {
          value: "stable",
          label: "Stable",
          hint: "bumps ALL publishable packages (alpha counter resets to 1)",
        },
        {
          value: "alpha",
          label: "Alpha",
          hint: "bumps alpha packages only (alpha.N → alpha.N+1)",
        },
      ],
    }),
  );

  let kind: Kind | undefined;
  if (mode === "stable") {
    kind = unwrap(
      await select<Kind>({
        message: "Release kind",
        options: [
          { value: "patch", label: "patch", hint: "x.y.Z" },
          { value: "minor", label: "minor", hint: "x.Y.0" },
          { value: "major", label: "major", hint: "X.0.0" },
        ],
      }),
    );
  } else {
    if (alphaPkgs.length === 0) abort("No alpha packages to bump.");
    log.warn(
      pc.yellow(
        "Alpha packages publish with BOTH `alpha` and `latest` dist-tags.\n" +
          "After publish, `npm install @docukit/<pkg>` (no tag) returns the new alpha.",
      ),
    );
    const ok = unwrap(
      await confirm({
        message: "Continue with an alpha bump?",
        initialValue: false,
      }),
    );
    if (!ok) abort("Aborted.");
  }

  const targets = mode === "alpha" ? alphaPkgs : publishable;
  const plan: PlanEntry[] = [];
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  for (const entry of targets) {
    const parsed =
      parseVersion(entry.pkg.version) ??
      abort(`${entry.pkg.name}: cannot parse "${entry.pkg.version}"`);
    const wasAlpha = isAlpha(entry.pkg);
    const next = applyBump(parsed, mode, kind, wasAlpha);
    const tag = mode === "alpha" ? "alpha" : wasAlpha ? "alpha" : "latest";
    const publishedVersion = distTags[entry.pkg.name]?.[tag];

    let status: PlanEntry["status"] = "ok";
    if (!publishedVersion) {
      status = "first-publish";
    } else if (formatVersion(next) === publishedVersion) {
      status = "warning";
      hardErrors.push(
        `${entry.pkg.name}: proposed ${formatVersion(next)} is ALREADY on the registry`,
      );
    } else {
      const g = guardrail(publishedVersion, parsed, next, mode, kind, wasAlpha);
      if (!g.ok) {
        status = "warning";
        warnings.push(`${entry.pkg.name}: ${g.reason}`);
      }
    }
    plan.push({ ...entry, parsed, next, status, publishedVersion });
  }

  if (hardErrors.length) {
    abort(
      "Proposed version is already on the registry:\n  " +
        hardErrors.join("\n  "),
    );
  }

  const planLines = plan.map((p) => {
    const badge =
      p.status === "first-publish"
        ? pc.green("  [first publish]")
        : p.status === "warning"
          ? pc.yellow("  [unusual]")
          : "";
    const pub = p.publishedVersion ?? "(unpublished)";
    return `${pc.bold(p.pkg.name)}  ${formatVersion(p.parsed)} ${pc.dim("→")} ${pc.green(formatVersion(p.next))}${badge}\n  ${pc.dim(`registry: ${pub}`)}`;
  });
  note(planLines.join("\n"), "Proposed bumps");

  if (warnings.length) {
    log.warn(
      pc.yellow(
        "Unusual bump — local versions are not exactly +1 from the registry:\n" +
          warnings.map((w) => `  ${w}`).join("\n") +
          "\nThis usually means a previous release was bumped locally but never published.\n" +
          "The publish workflow is idempotent — publishing the pending release first is simplest.",
      ),
    );
    const ok = unwrap(
      await confirm({
        message: "Continue with this bump anyway?",
        initialValue: false,
      }),
    );
    if (!ok) abort("Aborted.");
  }

  const write = unwrap(
    await confirm({ message: "Write these changes?", initialValue: true }),
  );
  if (!write) abort("Aborted.");

  for (const p of plan) {
    const newV = formatVersion(p.next);
    const updated = p.raw.replace(
      /("version"\s*:\s*")[^"]+(")/,
      (_m, a: string, b: string) => `${a}${newV}${b}`,
    );
    writeFileSync(p.pkgPath, updated);
  }

  // Release tag: prefer stable (non-alpha) versions. If all bumps are alpha-only,
  // include -alpha.N. Sort by package name for determinism when selecting a fallback.
  const stableEntry = plan.find((p) => p.next.alpha === undefined);
  const fallback = [...plan].sort((a, b) =>
    a.pkg.name.localeCompare(b.pkg.name),
  )[0];
  const tagSource =
    stableEntry ?? fallback ?? abort("internal: no plan entries after bump");
  const releaseStr =
    tagSource.next.alpha === undefined
      ? `v${tagSource.next.major}.${tagSource.next.minor}.${tagSource.next.patch}`
      : `v${formatVersion(tagSource.next)}`;

  outro(
    `${pc.green(`✓ Bumped ${plan.length} package(s).`)} ` +
      pc.dim(
        `Return to the /release skill — next release: ${pc.bold(releaseStr)}.`,
      ),
  );
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

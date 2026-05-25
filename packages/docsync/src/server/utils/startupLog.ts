import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ansi = {
  blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
};

function isPackageJson(value: unknown): value is { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  );
}

function readDocSyncVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPaths = [
    resolve(moduleDir, "../../../package.json"),
    resolve(moduleDir, "../../../../package.json"),
  ];

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const packageJson: unknown = JSON.parse(
        readFileSync(packageJsonPath, "utf8"),
      );
      if (isPackageJson(packageJson)) return packageJson.version;
    } catch {
      // Source and dist builds place this module at different depths.
    }
  }

  return "unknown";
}

export function startupLog(port: number): string {
  return [
    "",
    `  ${ansi.blue(`DocSync v${readDocSyncVersion()}`)}`,
    "",
    `  ${ansi.green("➜")}  Local:   ${ansi.cyan(`http://localhost:${port}/`)}`,
    "",
  ].join("\n");
}

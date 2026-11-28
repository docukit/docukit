// Wall time of every phase of a measurement, merged into <dir>/wall.json (report.ts prints the phases and the total).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
export const phase = (dir: string, name: string, f: () => void) => {
  const t0 = Date.now();
  f();
  const file = `${dir}/wall.json`;
  const wall = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { phases: {} };
  wall.phases[name] = {
    minutes: (Date.now() - t0) / 60000,
    started: new Date(t0).toISOString(),
    ended: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(wall, null, 1));
  console.log(
    new Date().toISOString(),
    "wall time of",
    name,
    ((Date.now() - t0) / 60000).toFixed(1),
    "min",
  );
};

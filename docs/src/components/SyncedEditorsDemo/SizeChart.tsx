"use client";

import type { SizeMeasurement } from "./SizeBenchPlugin";

const CHART_W = 800;
const CHART_H = 360;
const PAD = { top: 24, right: 24, bottom: 36, left: 55 };
const INNER_W = CHART_W - PAD.left - PAD.right;
const INNER_H = CHART_H - PAD.top - PAD.bottom;

const COLORS = { docNode: "#3b82f6", yjs: "#f59e0b" };

function buildPoints(
  data: SizeMeasurement[],
  key: "docNodeGz" | "yjsGz",
  yMin: number,
  yMax: number,
): string {
  if (data.length === 0) return "";
  const xStep = data.length === 1 ? 0 : INNER_W / (data.length - 1);
  return data
    .map((d, i) => {
      const ratio = d[key] / d.editorStateGz;
      const x = PAD.left + i * xStep;
      const y = PAD.top + INNER_H - ((ratio - yMin) / (yMax - yMin)) * INNER_H;
      return `${x},${y}`;
    })
    .join(" ");
}

function yTicks(yMin: number, yMax: number): number[] {
  const ticks: number[] = [];
  const step = niceStep(yMin, yMax, 5);
  const start = Math.ceil(yMin / step) * step;
  for (let v = start; v <= yMax + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return ticks;
}

function niceStep(min: number, max: number, targetTicks: number): number {
  const range = max - min || 1;
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / mag;
  if (residual <= 1.5) return mag;
  if (residual <= 3) return 2 * mag;
  if (residual <= 7) return 5 * mag;
  return 10 * mag;
}

export function SizeChart({ data }: { data: SizeMeasurement[] }) {
  if (data.length < 2) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-2xl border border-slate-700/50 bg-slate-900/60 text-sm text-slate-500">
        Start typing to see the size comparison chart…
      </div>
    );
  }

  // Compute Y range from ratios
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const d of data) {
    const rDoc = d.docNodeGz / d.editorStateGz;
    const rYjs = d.yjsGz / d.editorStateGz;
    yMin = Math.min(yMin, rDoc, rYjs);
    yMax = Math.max(yMax, rDoc, rYjs);
  }
  // Add padding
  const range = yMax - yMin || 0.1;
  yMin = Math.max(0, yMin - range * 0.1);
  yMax = yMax + range * 0.1;

  const docPoints = buildPoints(data, "docNodeGz", yMin, yMax);
  const yjsPoints = buildPoints(data, "yjsGz", yMin, yMax);
  const ticks = yTicks(yMin, yMax);

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-6 backdrop-blur-sm">
      <div className="mb-4 flex items-center gap-6 text-sm text-slate-400">
        <span>
          <span
            className="mr-1.5 inline-block h-2 w-4 rounded-sm"
            style={{ backgroundColor: COLORS.docNode }}
          />
          DocNode / EditorState (gzip)
        </span>
        <span>
          <span
            className="mr-1.5 inline-block h-2 w-4 rounded-sm"
            style={{ backgroundColor: COLORS.yjs }}
          />
          Yjs / EditorState (gzip)
        </span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-[360px] w-full">
        {/* Y axis ticks and grid */}
        {ticks.map((v) => {
          const y = PAD.top + INNER_H - ((v - yMin) / (yMax - yMin)) * INNER_H;
          return (
            <g key={v}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + INNER_W}
                y2={y}
                stroke="#334155"
                strokeWidth={0.5}
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                fill="#94a3b8"
                fontSize={13}
              >
                {v.toFixed(2)}x
              </text>
            </g>
          );
        })}

        {/* X axis label */}
        <text
          x={PAD.left + INNER_W / 2}
          y={CHART_H - 4}
          textAnchor="middle"
          fill="#64748b"
          fontSize={13}
        >
          updates
        </text>

        {/* Lines */}
        <polyline
          points={docPoints}
          fill="none"
          stroke={COLORS.docNode}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <polyline
          points={yjsPoints}
          fill="none"
          stroke={COLORS.yjs}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

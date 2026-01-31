import { BLUE } from "@/lib/brand-colors";

// 1. CANVAS SIZE
const VIEWBOX_SIZE = 1000;

// 2. DESIGN VARIABLES
const CENTER_CIRCLE_RADIUS = VIEWBOX_SIZE * 0.16;
const OUTER_CIRCLE_RADIUS = VIEWBOX_SIZE * 0.11;
const ARM_LENGTH =
  VIEWBOX_SIZE / 2 - CENTER_CIRCLE_RADIUS - OUTER_CIRCLE_RADIUS;
const GRAPH_LINES_WIDTH = VIEWBOX_SIZE * 0.09;
const COLOR = BLUE;

// Derived values
const CENTER = VIEWBOX_SIZE / 2;
const OUTER_DISTANCE = ARM_LENGTH + CENTER_CIRCLE_RADIUS;

export default function DocSyncLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      width={VIEWBOX_SIZE}
      height={VIEWBOX_SIZE}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Lines to cardinal directions */}
      {/* Up */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={CENTER}
        y2={CENTER - OUTER_DISTANCE}
        stroke={COLOR}
        strokeWidth={GRAPH_LINES_WIDTH}
      />
      {/* Down */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={CENTER}
        y2={CENTER + OUTER_DISTANCE}
        stroke={COLOR}
        strokeWidth={GRAPH_LINES_WIDTH}
      />
      {/* Left */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={CENTER - OUTER_DISTANCE}
        y2={CENTER}
        stroke={COLOR}
        strokeWidth={GRAPH_LINES_WIDTH}
      />
      {/* Right */}
      <line
        x1={CENTER}
        y1={CENTER}
        x2={CENTER + OUTER_DISTANCE}
        y2={CENTER}
        stroke={COLOR}
        strokeWidth={GRAPH_LINES_WIDTH}
      />

      {/* Outer circles at cardinal points */}
      <circle
        cx={CENTER}
        cy={CENTER - OUTER_DISTANCE}
        r={OUTER_CIRCLE_RADIUS}
        fill={COLOR}
      />
      <circle
        cx={CENTER}
        cy={CENTER + OUTER_DISTANCE}
        r={OUTER_CIRCLE_RADIUS}
        fill={COLOR}
      />
      <circle
        cx={CENTER - OUTER_DISTANCE}
        cy={CENTER}
        r={OUTER_CIRCLE_RADIUS}
        fill={COLOR}
      />
      <circle
        cx={CENTER + OUTER_DISTANCE}
        cy={CENTER}
        r={OUTER_CIRCLE_RADIUS}
        fill={COLOR}
      />

      {/* Central circle (drawn last to be on top) */}
      <circle cx={CENTER} cy={CENTER} r={CENTER_CIRCLE_RADIUS} fill={COLOR} />
    </svg>
  );
}

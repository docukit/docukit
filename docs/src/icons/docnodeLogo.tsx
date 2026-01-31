import { GREEN } from "@/lib/brand-colors";

// 1. CANVAS SIZE (doesn't matter)
const VIEWBOX_HEIGHT = 1000;

// 2. DESIGN VARIABLES (the ones in lowercase are derived, don't change them)
const TOP_CIRCLE_RADIUS = VIEWBOX_HEIGHT * 0.15;
const BOTTOM_CIRCLE_RADIUS = VIEWBOX_HEIGHT * 0.15;
const ANGLE_TRIANGLE = 65; // in degrees
const GRAPH_LINES_WIDTH = VIEWBOX_HEIGHT * 0.1;
const COLOR = GREEN;

const triangle_height =
  VIEWBOX_HEIGHT - TOP_CIRCLE_RADIUS - BOTTOM_CIRCLE_RADIUS;
const angle_rad = (ANGLE_TRIANGLE * Math.PI) / 180;
const BASE_TRIANGLE = (2 * triangle_height) / Math.tan(angle_rad); // h/tan(α)
const distance_to_circuncenter =
  BASE_TRIANGLE / (4 * Math.cos(angle_rad) * Math.sin(angle_rad)); // in isosc. to barycenter is 2/3
const CENTER_Y = distance_to_circuncenter + TOP_CIRCLE_RADIUS;

const viewBox_width = BASE_TRIANGLE + 2 * BOTTOM_CIRCLE_RADIUS + 1; // 1 extra px to avoid rounding errors (due to PI probably)
const centerX = viewBox_width / 2;
const topY = TOP_CIRCLE_RADIUS;
const bottomY = topY + triangle_height;
const leftX = centerX - BASE_TRIANGLE / 2;
const rightX = centerX + BASE_TRIANGLE / 2;

export default function Logo({ className }: { className?: string }) {
  return (
    <>
      <svg
        viewBox={`0 0 ${viewBox_width} ${VIEWBOX_HEIGHT}`}
        width={viewBox_width}
        height={VIEWBOX_HEIGHT}
        xmlns="http://www.w3.org/2000/svg"
        className={className}
      >
        {/* Conexiones */}
        <line
          x1={centerX}
          y1={topY}
          x2={centerX}
          y2={CENTER_Y}
          stroke={COLOR}
          strokeWidth={GRAPH_LINES_WIDTH}
        />
        <line
          x1={centerX}
          y1={CENTER_Y}
          x2={leftX}
          y2={bottomY}
          stroke={COLOR}
          strokeWidth={GRAPH_LINES_WIDTH}
        />
        <line
          x1={centerX}
          y1={CENTER_Y}
          x2={rightX}
          y2={bottomY}
          stroke={COLOR}
          strokeWidth={GRAPH_LINES_WIDTH}
        />

        {/* Nodos */}
        <circle cx={centerX} cy={topY} r={TOP_CIRCLE_RADIUS} fill={COLOR} />
        <circle cx={leftX} cy={bottomY} r={BOTTOM_CIRCLE_RADIUS} fill={COLOR} />
        <circle
          cx={rightX}
          cy={bottomY}
          r={BOTTOM_CIRCLE_RADIUS}
          fill={COLOR}
        />
      </svg>
    </>
  );
}

import React, { useId } from "react";
import { GREEN, BLUE, WHITE } from "@/lib/brand-colors";

// ViewBox size (internal coordinate system)
const VIEWBOX_SIZE = 200;
const SQUARE_SIZE = VIEWBOX_SIZE / 2; // 100
const ICON_PADDING = 15;
const ICON_SIZE = SQUARE_SIZE - ICON_PADDING * 2; // 70
const CORNER_RADIUS = 16; // Rounded corners

interface LogoProps {
  className?: string;
  size?: number;
}

// DocNode icon (tree structure) - white version
function DocNodeIcon({ x, y, size }: { x: number; y: number; size: number }) {
  const scale = size / 100;
  const cx = x + size / 2;
  const topY = y + 15 * scale;
  const centerY = y + 40 * scale;
  const bottomY = y + 85 * scale;
  const leftX = x + 20 * scale;
  const rightX = x + size - 20 * scale;
  const lineWidth = 8 * scale;
  const topRadius = 12 * scale;
  const bottomRadius = 10 * scale;

  return (
    <g>
      <line
        x1={cx}
        y1={topY}
        x2={cx}
        y2={centerY}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={cx}
        y1={centerY}
        x2={leftX}
        y2={bottomY}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={cx}
        y1={centerY}
        x2={rightX}
        y2={bottomY}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <circle cx={cx} cy={topY} r={topRadius} fill={WHITE} />
      <circle cx={leftX} cy={bottomY} r={bottomRadius} fill={WHITE} />
      <circle cx={rightX} cy={bottomY} r={bottomRadius} fill={WHITE} />
    </g>
  );
}

// DocSync icon (cross with center) - white version
function DocSyncIcon({ x, y, size }: { x: number; y: number; size: number }) {
  const scale = size / 100;
  const center = x + size / 2;
  const centerY = y + size / 2;
  const extent = 35 * scale;
  const lineWidth = 7 * scale;
  const centerRadius = 12 * scale;
  const outerRadius = 8 * scale;

  return (
    <g>
      <line
        x1={center}
        y1={centerY}
        x2={center}
        y2={centerY - extent}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={center}
        y1={centerY}
        x2={center}
        y2={centerY + extent}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={center}
        y1={centerY}
        x2={center - extent}
        y2={centerY}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={center}
        y1={centerY}
        x2={center + extent}
        y2={centerY}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <circle cx={center} cy={centerY - extent} r={outerRadius} fill={WHITE} />
      <circle cx={center} cy={centerY + extent} r={outerRadius} fill={WHITE} />
      <circle cx={center - extent} cy={centerY} r={outerRadius} fill={WHITE} />
      <circle cx={center + extent} cy={centerY} r={outerRadius} fill={WHITE} />
      <circle cx={center} cy={centerY} r={centerRadius} fill={WHITE} />
    </g>
  );
}

// DocEditor icon (horizontal lines with dots) - white version
function DocEditorIcon({ x, y, size }: { x: number; y: number; size: number }) {
  const scale = size / 100;
  const startX = x + 20 * scale;
  const endX = x + size - 15 * scale;
  const lineWidth = 7 * scale;
  const nodeRadius = 8 * scale;
  const lines = [
    { y: y + 25 * scale },
    { y: y + 50 * scale },
    { y: y + 75 * scale },
  ];

  return (
    <g>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          <line
            x1={startX}
            y1={line.y}
            x2={endX}
            y2={line.y}
            stroke={WHITE}
            strokeWidth={lineWidth}
            strokeLinecap="round"
          />
          <circle cx={startX} cy={line.y} r={nodeRadius} fill={WHITE} />
        </React.Fragment>
      ))}
    </g>
  );
}

// DocGrid icon (square with corners) - white version
function DocGridIcon({ x, y, size }: { x: number; y: number; size: number }) {
  const scale = size / 100;
  const offset = 25 * scale;
  const corners = [
    { x: x + offset, y: y + offset },
    { x: x + size - offset, y: y + offset },
    { x: x + offset, y: y + size - offset },
    { x: x + size - offset, y: y + size - offset },
  ];
  const lineWidth = 7 * scale;
  const nodeRadius = 10 * scale;

  return (
    <g>
      <line
        x1={corners[0].x}
        y1={corners[0].y}
        x2={corners[1].x}
        y2={corners[1].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={corners[1].x}
        y1={corners[1].y}
        x2={corners[3].x}
        y2={corners[3].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={corners[3].x}
        y1={corners[3].y}
        x2={corners[2].x}
        y2={corners[2].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      <line
        x1={corners[2].x}
        y1={corners[2].y}
        x2={corners[0].x}
        y2={corners[0].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
      />
      {corners.map((corner, i) => (
        <circle
          key={i}
          cx={corner.x}
          cy={corner.y}
          r={nodeRadius}
          fill={WHITE}
        />
      ))}
    </g>
  );
}

// Main combined logo - 4 squares with icons and rounded corners
export default function DocuKitLogo({ className, size = 200 }: LogoProps) {
  const clipId = `rounded-clip-${useId()}`;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <clipPath id={clipId}>
          <rect
            x={0}
            y={0}
            width={VIEWBOX_SIZE}
            height={VIEWBOX_SIZE}
            rx={CORNER_RADIUS}
            ry={CORNER_RADIUS}
          />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        {/* Top-left: Green - DocNode */}
        <rect
          x={0}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />
        <DocNodeIcon x={ICON_PADDING} y={ICON_PADDING} size={ICON_SIZE} />

        {/* Top-right: Blue - DocSync */}
        <rect
          x={SQUARE_SIZE}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />
        <DocSyncIcon
          x={SQUARE_SIZE + ICON_PADDING}
          y={ICON_PADDING}
          size={ICON_SIZE}
        />

        {/* Bottom-left: Blue - DocEditor */}
        <rect
          x={0}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />
        <DocEditorIcon
          x={ICON_PADDING}
          y={SQUARE_SIZE + ICON_PADDING}
          size={ICON_SIZE}
        />

        {/* Bottom-right: Green - DocGrid */}
        <rect
          x={SQUARE_SIZE}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />
        <DocGridIcon
          x={SQUARE_SIZE + ICON_PADDING}
          y={SQUARE_SIZE + ICON_PADDING}
          size={ICON_SIZE}
        />
      </g>
    </svg>
  );
}

// Circular version of the main logo
export function DocuKitLogoCircular({ className, size = 200 }: LogoProps) {
  const clipId = `circle-clip-${useId()}`;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <clipPath id={clipId}>
          <circle
            cx={VIEWBOX_SIZE / 2}
            cy={VIEWBOX_SIZE / 2}
            r={VIEWBOX_SIZE / 2}
          />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        {/* Top-left: Green - DocNode */}
        <rect
          x={0}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />
        <DocNodeIcon x={ICON_PADDING} y={ICON_PADDING} size={ICON_SIZE} />

        {/* Top-right: Blue - DocSync */}
        <rect
          x={SQUARE_SIZE}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />
        <DocSyncIcon
          x={SQUARE_SIZE + ICON_PADDING}
          y={ICON_PADDING}
          size={ICON_SIZE}
        />

        {/* Bottom-left: Blue - DocEditor */}
        <rect
          x={0}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />
        <DocEditorIcon
          x={ICON_PADDING}
          y={SQUARE_SIZE + ICON_PADDING}
          size={ICON_SIZE}
        />

        {/* Bottom-right: Green - DocGrid */}
        <rect
          x={SQUARE_SIZE}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />
        <DocGridIcon
          x={SQUARE_SIZE + ICON_PADDING}
          y={SQUARE_SIZE + ICON_PADDING}
          size={ICON_SIZE}
        />
      </g>
    </svg>
  );
}

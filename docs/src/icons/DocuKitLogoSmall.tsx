import React from "react";

// Colors
const GREEN = "#00C853";
const BLUE = "#1b68f5";
const WHITE = "#FFFFFF";

// Size constants
const SQUARE_SIZE = 100;
const TOTAL_SIZE = SQUARE_SIZE * 2;

interface LogoProps {
  className?: string;
  size?: number;
}

// Simplified DocNode icon (tree structure) - thinner lines, no circles
function DocNodeIconSimple({
  x,
  y,
  size,
}: {
  x: number;
  y: number;
  size: number;
}) {
  const scale = size / 100;
  const cx = x + size / 2;
  const topY = y + 15 * scale;
  const centerY = y + 40 * scale;
  const bottomY = y + 85 * scale;
  const leftX = x + 20 * scale;
  const rightX = x + size - 20 * scale;
  const lineWidth = 4 * scale;

  return (
    <g>
      <line
        x1={cx}
        y1={topY}
        x2={cx}
        y2={centerY}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <line
        x1={cx}
        y1={centerY}
        x2={leftX}
        y2={bottomY}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <line
        x1={cx}
        y1={centerY}
        x2={rightX}
        y2={bottomY}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
    </g>
  );
}

// Simplified DocSync icon (cross) - thinner lines, no circles
function DocSyncIconSimple({
  x,
  y,
  size,
}: {
  x: number;
  y: number;
  size: number;
}) {
  const scale = size / 100;
  const center = x + size / 2;
  const centerY = y + size / 2;
  const extent = 38 * scale;
  const lineWidth = 4 * scale;

  return (
    <g>
      <line
        x1={center}
        y1={centerY - extent}
        x2={center}
        y2={centerY + extent}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <line
        x1={center - extent}
        y1={centerY}
        x2={center + extent}
        y2={centerY}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
    </g>
  );
}

// Simplified DocEditor icon (horizontal lines) - thinner lines, no circles
function DocEditorIconSimple({
  x,
  y,
  size,
}: {
  x: number;
  y: number;
  size: number;
}) {
  const scale = size / 100;
  const startX = x + 15 * scale;
  const endX = x + size - 15 * scale;
  const lineWidth = 4 * scale;
  const lines = [
    { y: y + 25 * scale },
    { y: y + 50 * scale },
    { y: y + 75 * scale },
  ];

  return (
    <g>
      {lines.map((line, i) => (
        <line
          key={i}
          x1={startX}
          y1={line.y}
          x2={endX}
          y2={line.y}
          stroke={WHITE}
          strokeWidth={lineWidth}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

// Simplified DocGrid icon (square outline) - thinner lines, no circles
function DocGridIconSimple({
  x,
  y,
  size,
}: {
  x: number;
  y: number;
  size: number;
}) {
  const scale = size / 100;
  const offset = 20 * scale;
  const corners = [
    { x: x + offset, y: y + offset },
    { x: x + size - offset, y: y + offset },
    { x: x + offset, y: y + size - offset },
    { x: x + size - offset, y: y + size - offset },
  ];
  const lineWidth = 4 * scale;

  return (
    <g>
      <line
        x1={corners[0].x}
        y1={corners[0].y}
        x2={corners[1].x}
        y2={corners[1].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <line
        x1={corners[1].x}
        y1={corners[1].y}
        x2={corners[3].x}
        y2={corners[3].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <line
        x1={corners[3].x}
        y1={corners[3].y}
        x2={corners[2].x}
        y2={corners[2].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <line
        x1={corners[2].x}
        y1={corners[2].y}
        x2={corners[0].x}
        y2={corners[0].y}
        stroke={WHITE}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
    </g>
  );
}

// Small/simplified combined logo - 4 squares with simplified icons
export default function DocuKitLogoSmall({ className, size = 100 }: LogoProps) {
  const iconSize = SQUARE_SIZE * 0.7;
  const iconOffset = (SQUARE_SIZE - iconSize) / 2;

  return (
    <svg
      viewBox={`0 0 ${TOTAL_SIZE} ${TOTAL_SIZE}`}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Top-left: Green - DocNode */}
      <rect x={0} y={0} width={SQUARE_SIZE} height={SQUARE_SIZE} fill={GREEN} />
      <DocNodeIconSimple x={iconOffset} y={iconOffset} size={iconSize} />

      {/* Top-right: Blue - DocSync */}
      <rect
        x={SQUARE_SIZE}
        y={0}
        width={SQUARE_SIZE}
        height={SQUARE_SIZE}
        fill={BLUE}
      />
      <DocSyncIconSimple
        x={SQUARE_SIZE + iconOffset}
        y={iconOffset}
        size={iconSize}
      />

      {/* Bottom-left: Blue - DocEditor */}
      <rect
        x={0}
        y={SQUARE_SIZE}
        width={SQUARE_SIZE}
        height={SQUARE_SIZE}
        fill={BLUE}
      />
      <DocEditorIconSimple
        x={iconOffset}
        y={SQUARE_SIZE + iconOffset}
        size={iconSize}
      />

      {/* Bottom-right: Green - DocGrid */}
      <rect
        x={SQUARE_SIZE}
        y={SQUARE_SIZE}
        width={SQUARE_SIZE}
        height={SQUARE_SIZE}
        fill={GREEN}
      />
      <DocGridIconSimple
        x={SQUARE_SIZE + iconOffset}
        y={SQUARE_SIZE + iconOffset}
        size={iconSize}
      />
    </svg>
  );
}

// Circular version of the small logo
export function DocuKitLogoSmallCircular({ className, size = 100 }: LogoProps) {
  const iconSize = SQUARE_SIZE * 0.7;
  const iconOffset = (SQUARE_SIZE - iconSize) / 2;
  const clipId = `circle-clip-small-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <svg
      viewBox={`0 0 ${TOTAL_SIZE} ${TOTAL_SIZE}`}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx={TOTAL_SIZE / 2} cy={TOTAL_SIZE / 2} r={TOTAL_SIZE / 2} />
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
        <DocNodeIconSimple x={iconOffset} y={iconOffset} size={iconSize} />

        {/* Top-right: Blue - DocSync */}
        <rect
          x={SQUARE_SIZE}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />
        <DocSyncIconSimple
          x={SQUARE_SIZE + iconOffset}
          y={iconOffset}
          size={iconSize}
        />

        {/* Bottom-left: Blue - DocEditor */}
        <rect
          x={0}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />
        <DocEditorIconSimple
          x={iconOffset}
          y={SQUARE_SIZE + iconOffset}
          size={iconSize}
        />

        {/* Bottom-right: Green - DocGrid */}
        <rect
          x={SQUARE_SIZE}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />
        <DocGridIconSimple
          x={SQUARE_SIZE + iconOffset}
          y={SQUARE_SIZE + iconOffset}
          size={iconSize}
        />
      </g>
    </svg>
  );
}

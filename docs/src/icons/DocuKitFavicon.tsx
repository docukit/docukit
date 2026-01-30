import React from "react";

// Colors
const GREEN = "#00C853";
const BLUE = "#1b68f5";

// Size constants
const SQUARE_SIZE = 50;
const TOTAL_SIZE = SQUARE_SIZE * 2;

interface FaviconProps {
  className?: string;
  size?: number;
}

// Favicon - 4 colored squares (no icons)
export default function DocuKitFavicon({
  className,
  size = 100,
}: FaviconProps) {
  return (
    <svg
      viewBox={`0 0 ${TOTAL_SIZE} ${TOTAL_SIZE}`}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Top-left: Green */}
      <rect x={0} y={0} width={SQUARE_SIZE} height={SQUARE_SIZE} fill={GREEN} />

      {/* Top-right: Blue */}
      <rect
        x={SQUARE_SIZE}
        y={0}
        width={SQUARE_SIZE}
        height={SQUARE_SIZE}
        fill={BLUE}
      />

      {/* Bottom-left: Blue */}
      <rect
        x={0}
        y={SQUARE_SIZE}
        width={SQUARE_SIZE}
        height={SQUARE_SIZE}
        fill={BLUE}
      />

      {/* Bottom-right: Green */}
      <rect
        x={SQUARE_SIZE}
        y={SQUARE_SIZE}
        width={SQUARE_SIZE}
        height={SQUARE_SIZE}
        fill={GREEN}
      />
    </svg>
  );
}

// Circular version of the favicon
export function DocuKitFaviconCircular({
  className,
  size = 100,
}: FaviconProps) {
  const clipId = `circle-clip-favicon-${Math.random().toString(36).substr(2, 9)}`;

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
        {/* Top-left: Green */}
        <rect
          x={0}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />

        {/* Top-right: Blue */}
        <rect
          x={SQUARE_SIZE}
          y={0}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />

        {/* Bottom-left: Blue */}
        <rect
          x={0}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={BLUE}
        />

        {/* Bottom-right: Green */}
        <rect
          x={SQUARE_SIZE}
          y={SQUARE_SIZE}
          width={SQUARE_SIZE}
          height={SQUARE_SIZE}
          fill={GREEN}
        />
      </g>
    </svg>
  );
}

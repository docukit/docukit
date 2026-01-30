import React from "react";

// Colors
const GREEN = "#00C853";
const BLUE = "#1b68f5";

// ViewBox size (internal coordinate system)
const VIEWBOX_SIZE = 100;
const SQUARE_SIZE = VIEWBOX_SIZE / 2; // 50

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
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
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

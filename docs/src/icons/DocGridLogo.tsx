import React from "react";

const VIEWBOX_SIZE = 1000;
const COLOR = "#00C853"; // Green
const NODE_RADIUS = VIEWBOX_SIZE * 0.12;
const LINE_WIDTH = VIEWBOX_SIZE * 0.08;

export default function DocGridLogo({ className }: { className?: string }) {
  const nodes = [
    { x: 300, y: 300 },
    { x: 700, y: 300 },
    { x: 300, y: 700 },
    { x: 700, y: 700 },
  ];

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      width={VIEWBOX_SIZE}
      height={VIEWBOX_SIZE}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <line
        x1={nodes[0].x}
        y1={nodes[0].y}
        x2={nodes[1].x}
        y2={nodes[1].y}
        stroke={COLOR}
        strokeWidth={LINE_WIDTH}
      />
      <line
        x1={nodes[1].x}
        y1={nodes[1].y}
        x2={nodes[3].x}
        y2={nodes[3].y}
        stroke={COLOR}
        strokeWidth={LINE_WIDTH}
      />
      <line
        x1={nodes[3].x}
        y1={nodes[3].y}
        x2={nodes[2].x}
        y2={nodes[2].y}
        stroke={COLOR}
        strokeWidth={LINE_WIDTH}
      />
      <line
        x1={nodes[2].x}
        y1={nodes[2].y}
        x2={nodes[0].x}
        y2={nodes[0].y}
        stroke={COLOR}
        strokeWidth={LINE_WIDTH}
      />

      {nodes.map((node, i) => (
        <circle key={i} cx={node.x} cy={node.y} r={NODE_RADIUS} fill={COLOR} />
      ))}
    </svg>
  );
}

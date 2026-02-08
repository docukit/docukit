import React from "react";

export default function DocuKitFaviconCircles({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="25" cy="25" r="20" fill="#00C853" /> {/* Green */}
      <circle cx="75" cy="25" r="20" fill="#1b68f5" /> {/* Blue */}
      <circle cx="25" cy="75" r="20" fill="#1b68f5" /> {/* Blue */}
      <circle cx="75" cy="75" r="20" fill="#00C853" /> {/* Green */}
    </svg>
  );
}

/**
 * Brand colors - Single source of truth for DocuKit color palette
 * These colors match Tailwind's emerald-600 and blue-600
 */

export const BRAND_COLORS = {
  GREEN: "#00a63e", // green-600
  BLUE: "#2563eb", // blue-600
  WHITE: "#FFFFFF",
} as const;

// Export individual colors for convenience
export const { GREEN, BLUE, WHITE } = BRAND_COLORS;

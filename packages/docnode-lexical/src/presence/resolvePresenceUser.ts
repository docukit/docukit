import type { PresenceUser } from "../types.js";

const DEFAULT_PRESENCE_NAME = "Anonymous";
const DEFAULT_PRESENCE_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#4f46e5",
  "#dc2626",
  "#0d9488",
  "#7c3aed",
  "#ca8a04",
  "#0284c7",
];

function createDefaultPresenceColor(): string {
  return (
    DEFAULT_PRESENCE_COLORS[
      Math.floor(Math.random() * DEFAULT_PRESENCE_COLORS.length)
    ] ?? "#2563eb"
  );
}

function createPresenceColorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }

  return (
    DEFAULT_PRESENCE_COLORS[Math.abs(hash) % DEFAULT_PRESENCE_COLORS.length] ??
    "#2563eb"
  );
}

export function resolvePresenceUser(user: PresenceUser | undefined): {
  name: string;
  color: string;
} {
  const name = user?.name ?? DEFAULT_PRESENCE_NAME;
  return {
    name,
    color:
      user?.color ??
      (user?.name == null
        ? createDefaultPresenceColor()
        : createPresenceColorFromName(user.name)),
  };
}

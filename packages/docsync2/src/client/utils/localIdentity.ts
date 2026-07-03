import type { Identity } from "../types.js";

export const LOCAL_IDENTITY_KEY = "docsync:localUserId";

export const readLocalIdentity = (): Identity | undefined => {
  if (typeof localStorage === "undefined") return undefined;
  const userId = localStorage.getItem(LOCAL_IDENTITY_KEY);
  if (!userId) return undefined;
  return { userId };
};

export const saveLocalIdentity = (identity: Identity): void => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LOCAL_IDENTITY_KEY, identity.userId);
};

export const clearLocalIdentity = (): void => {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LOCAL_IDENTITY_KEY);
};

import { notImplemented } from "../../shared/notImplemented.js";

export type Identity = { userId: string; secret?: string };

export const indexedDBProvider = (_identity: Identity): never => {
  throw notImplemented();
};

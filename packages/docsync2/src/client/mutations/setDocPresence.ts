import { notImplemented } from "../../shared/notImplemented.js";
import type { DocSyncClient } from "../index.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

export const setDocPresence = <TPresence = unknown>(
  _docSync: DocSyncClient,
  _args: SetDocPresenceArgs<TPresence>,
): Promise<void> => {
  return Promise.reject(notImplemented());
};

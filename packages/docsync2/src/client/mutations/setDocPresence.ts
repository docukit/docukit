import { notImplemented } from "../../shared/notImplemented.js";
import type { DocSyncClient } from "../index.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

export const setDocPresence = <
  D extends object,
  S extends object,
  O extends object,
  TPresence = unknown,
>(
  _docSync: DocSyncClient<D, S, O>,
  _args: SetDocPresenceArgs<TPresence>,
): Promise<void> => {
  return Promise.reject(notImplemented());
};

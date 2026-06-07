import { notImplemented } from "../../shared/notImplemented.js";
import type { DocSync2Client } from "../index.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

export const setDocPresence = <TPresence = unknown>(
  _docSync: DocSync2Client,
  _args: SetDocPresenceArgs<TPresence>,
): Promise<void> => {
  return Promise.reject(notImplemented());
};

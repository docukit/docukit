import type { QueryClient } from "@tanstack/query-core";
import { notImplemented } from "../../shared/notImplemented.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

export const setDocPresence = <TPresence = unknown>(
  _queryClient: QueryClient,
  _args: SetDocPresenceArgs<TPresence>,
): Promise<void> => {
  return Promise.reject(notImplemented());
};

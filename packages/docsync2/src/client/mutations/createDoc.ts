import type { QueryClient } from "@tanstack/query-core";
import { notImplemented } from "../../shared/notImplemented.js";
import type { ExistingDocQueryData } from "../../shared/types.js";

export type CreateDocArgs = { type: string; id: string };

export const createDoc = <D extends object = object>(
  _queryClient: QueryClient,
  _args: CreateDocArgs,
): Promise<ExistingDocQueryData<D>> => {
  return Promise.reject(notImplemented());
};

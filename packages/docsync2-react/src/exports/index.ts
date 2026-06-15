"use client";

import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
} from "@docukit/docsync2/client";

export function createDocSyncClient<
  D extends object,
  S extends object,
  O extends object,
>(config: ClientConfig<D, S, O> & { queryClient: QueryClient }) {
  const { queryClient } = config;
  const client = new DocSyncClient(config);

  function useDoc(args: GetDocArgs) {
    const type = args.type;
    const id = args.id;
    const queryOptions = useMemo(
      () => client.queries.getDoc({ type, id }),
      [type, id],
    );

    return useQuery(queryOptions, queryClient);
  }

  return { client, useDoc };
}

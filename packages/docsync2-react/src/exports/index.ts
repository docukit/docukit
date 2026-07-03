"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
  type Presence,
} from "@docukit/docsync2/client";

export function createDocSyncClient<
  D extends object,
  S extends object,
  O extends object,
>(config: ClientConfig<D, S, O>) {
  const client = new DocSyncClient(config);

  function useDoc(args: GetDocArgs) {
    const type = args.type;
    const id = args.id;
    const createIfMissing = args.createIfMissing;
    const queryOptions = useMemo(() => {
      return client.queries.getDoc({
        type,
        id,
        ...(createIfMissing === undefined ? {} : { createIfMissing }),
      });
    }, [type, id, createIfMissing]);

    return useQuery(queryOptions, client["_queryClient"]);
  }

  function usePresence(args: { docId: string | undefined }) {
    const [presence, setPresenceState] = useState<Presence>({});
    const docId = args.docId;
    const setPresence = useCallback(
      (nextPresence: unknown) => {
        if (!docId) return;
        void client.mutations.setDocPresence({ docId, presence: nextPresence });
      },
      [docId],
    );

    useEffect(() => {
      if (!docId) {
        setPresenceState({});
        return;
      }

      return client.queries.getDocPresence({ docId }, setPresenceState);
    }, [docId]);

    return [presence, setPresence] as const;
  }

  return { client, useDoc, usePresence };
}

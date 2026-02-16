"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
  type QueryResult,
  type Presence,
} from "@docukit/docsync/client";
import type { DocBinding } from "@docukit/docsync/shared";

// Helper types to infer D, S, O from ClientConfig
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferD<T> = T extends { docBinding: DocBinding<infer D, any, any> }
  ? D
  : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferS<T> = T extends { docBinding: DocBinding<any, infer S, any> }
  ? S
  : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferO<T> = T extends { docBinding: DocBinding<any, any, infer O> }
  ? O
  : never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDocSyncClient<T extends ClientConfig<any, any, any>>(
  config: T & ClientConfig<InferD<T>, InferS<T>, InferO<T>>,
) {
  type D = InferD<T>;
  type S = InferS<T>;
  type O = InferO<T>;

  // can't do this safely because can run on server during SSR
  const client =
    typeof window !== "undefined"
      ? new DocSyncClient(config as ClientConfig<D, S, O>)
      : undefined;

  type DocData = { doc: D; docId: string };

  function useDoc(args: {
    type: string;
    createIfMissing: true;
    id?: string;
  }): QueryResult<DocData>;
  function useDoc(args: {
    type: string;
    id: string;
    createIfMissing?: false;
  }): QueryResult<DocData | undefined>;
  function useDoc(args: GetDocArgs): QueryResult<DocData | undefined> {
    const [result, setResult] = useState<QueryResult<DocData | undefined>>({
      status: "loading",
    });
    const id = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    const type = args.type;
    const getDocArgs = useMemo<GetDocArgs | undefined>(() => {
      if (id !== undefined) return { type, id, createIfMissing };
      if (createIfMissing) return { type, createIfMissing: true };
      return undefined;
    }, [id, type, createIfMissing]);

    useEffect(() => {
      if (!client || !getDocArgs) return;
      return client.getDoc(getDocArgs, setResult);
    }, [getDocArgs]);

    return result;
  }

  function usePresence(args: { docId: string | undefined }) {
    const [presence, INTERNAL_setPresence] = useState<Presence>({});
    const { docId } = args;
    const getPresenceArgs = useMemo(() => ({ docId }), [docId]);
    // Wrap in useCallback to maintain stable reference across renders
    const setPresence = useCallback(
      (newPresence: unknown) => {
        if (!docId) return;
        void client?.setPresence({ docId, presence: newPresence });
      },
      [docId],
    );

    useEffect(() => {
      if (!client) return;
      return client.getPresence(getPresenceArgs, INTERNAL_setPresence);
    }, [getPresenceArgs]);

    return [presence, setPresence] as const;
  }

  return { useDoc, usePresence, client };
}

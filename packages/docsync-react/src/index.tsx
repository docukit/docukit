"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
  type QueryResult,
  type Presence,
  type DocBinding,
} from "@docukit/docsync/client";

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
  const serverSnapshot: QueryResult<DocData | undefined> = {
    status: "pending",
    fetchStatus: "fetching",
  };
  const getServerSnapshot = () => serverSnapshot;
  const subscribeWithoutClient = () => () => undefined;

  function useDoc(args: {
    type: string;
    createIfMissing: true;
    id: string;
  }): QueryResult<DocData>;
  function useDoc(args: {
    type: string;
    id: string;
    createIfMissing?: boolean;
  }): QueryResult<DocData | undefined>;
  function useDoc(args: GetDocArgs): QueryResult<DocData | undefined> {
    const id = args.id;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    const type = args.type;
    const getDocArgs = useMemo<GetDocArgs>(
      () => ({ type, id, createIfMissing }),
      [id, type, createIfMissing],
    );
    const observer = useMemo(
      () => client?.getDocObserver(getDocArgs),
      [getDocArgs],
    );

    // One snapshot source is used for both the first client render and every
    // later update. This prevents a changed id from briefly rendering the
    // previous document and gives React the consistency checks it needs for an
    // external store. SSR uses a stable pending snapshot until hydration.
    return useSyncExternalStore(
      observer?.subscribe ?? subscribeWithoutClient,
      observer?.getSnapshot ?? getServerSnapshot,
      getServerSnapshot,
    );
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

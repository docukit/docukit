"use client";

import React, { createContext, use, useLayoutEffect, useState } from "react";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
} from "@docnode/docsync/client";
import type { Doc, Operations } from "docnode";
import type { NN } from "../../docsync/dist/src/shared/docBinding.js";

const DocSyncClientContext = createContext<
  DocSyncClient<NN, Array<unknown>, Operations> | undefined
>(undefined);

export function DocSyncClientProvider(props: {
  config: ClientConfig<NN, Array<unknown>, Operations>;
  children: React.ReactNode;
}) {
  const { config, children } = props;
  const [client] = useState(() => new DocSyncClient(config));

  // useLayoutEffect(() => {
  //   setClient(new DocSyncClient(config));
  // }, []);

  return (
    <DocSyncClientContext.Provider value={client}>
      {children}
    </DocSyncClientContext.Provider>
  );
}

/**
 * React hook to get or create a document.
 *
 * The behavior depends on which fields are provided in `args`:
 * - `{ namespace, id }` → Try to get an existing doc. Returns `undefined` if not found.
 * - `{ namespace, createIfMissing: true }` → Create a new doc with auto-generated ID.
 * - `{ namespace, id, createIfMissing: true }` → Get existing doc or create it if not found.
 *
 * @example
 * ```tsx
 * // Get existing doc (might be undefined)
 * const doc = useDoc({ namespace: "notes", id: "abc123" });
 *
 * // Create new doc with auto-generated ID
 * const newDoc = useDoc({ namespace: "notes", createIfMissing: true });
 *
 * // Get or create (guaranteed to return a Doc once loaded)
 * const doc = useDoc({ namespace: "notes", id: "abc123", createIfMissing: true });
 * ```
 */
export function useDoc(args: {
  namespace: string;
  id?: string;
  createIfMissing: true;
}): Doc | undefined;
export function useDoc(args: {
  namespace: string;
  id: string;
  createIfMissing?: false;
}): Doc | undefined;
export function useDoc(args: GetDocArgs): Doc | undefined {
  const [doc, setDoc] = useState<Doc | undefined>();
  const client = use(DocSyncClientContext);

  // Use the provided id, or the loaded doc's id for cleanup
  const argsId = "id" in args ? args.id : undefined;
  const createIfMissing = "createIfMissing" in args && args.createIfMissing;

  const namespace = args.namespace;

  // The reason why I can't just `return client?.getDoc(args)` is because I get error
  // "async/await is not YET supported in Client Components". Maybe in the future.
  useLayoutEffect(() => {
    let loadedDocId: string | undefined;

    if (createIfMissing) {
      const getDocArgs = argsId
        ? { namespace, id: argsId, createIfMissing: true as const }
        : { namespace, createIfMissing: true as const };
      client
        ?.getDoc(getDocArgs)
        .then((loadedDoc) => {
          // TODO: fix this
          loadedDocId = (loadedDoc as Doc).root.id;
          setDoc(loadedDoc as Doc);
        })
        .catch(console.error);
    } else if (argsId) {
      client
        ?.getDoc({ namespace, id: argsId })
        .then((loadedDoc) => {
          // TODO: fix this
          loadedDocId = (loadedDoc as Doc)?.root.id;
          setDoc(loadedDoc as Doc);
        })
        .catch(console.error);
    }

    return () => {
      const idToUnload = argsId ?? loadedDocId;
      if (idToUnload) client?._unloadDoc(idToUnload).catch(console.error);
    };
  }, [client, argsId, namespace, createIfMissing]);

  return doc;
}

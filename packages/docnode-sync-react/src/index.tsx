"use client";

import React, { createContext, use, useLayoutEffect, useState } from "react";
import { DocRenderer, DocRenderer2 } from "./renderers.js";
import {
  DocNodeClient,
  type ClientConfig,
  type GetDocArgs,
} from "@docnode/sync/client";
import type { Doc } from "docnode";
export { DocRenderer, DocRenderer2 };

type ClientState = DocNodeClient | undefined;
const DocNodeClientContext = createContext<ClientState>(undefined);

export function DocNodeClientProvider(props: {
  config: ClientConfig;
  children: React.ReactNode;
}) {
  const { config, children } = props;
  const [client, setClient] = useState<ClientState>(undefined);

  useLayoutEffect(() => {
    setClient(new DocNodeClient(config));
  }, []);

  return (
    <DocNodeClientContext.Provider value={client}>
      {children}
    </DocNodeClientContext.Provider>
  );
}

/**
 * React hook to get or create a document.
 *
 * The behavior depends on which fields are provided in `args`:
 * - `{ id }` → Try to get an existing doc. Returns `undefined` if not found.
 * - `{ namespace }` → Create a new doc with auto-generated ID.
 * - `{ id, namespace }` → Get existing doc or create it if not found.
 *
 * @example
 * ```tsx
 * // Get existing doc (might be undefined)
 * const doc = useDoc({ id: "abc123" });
 *
 * // Create new doc with auto-generated ID
 * const newDoc = useDoc({ namespace: "notes" });
 *
 * // Get or create (guaranteed to return a Doc once loaded)
 * const doc = useDoc({ id: "abc123", namespace: "notes" });
 * ```
 */
export function useDoc(args: {
  namespace: string;
  id?: string;
}): Doc | undefined;
export function useDoc(args: { id: string }): Doc | undefined;
export function useDoc(args: GetDocArgs): Doc | undefined {
  const [doc, setDoc] = useState<Doc | undefined>();
  const client = use(DocNodeClientContext);

  // Use the provided id, or the loaded doc's id for cleanup
  const argsId = args.id;

  // The reason why I can't just `return client?.getDoc(args)` is because I get error
  // "async/await is not YET supported in Client Components". Maybe in the future.
  useLayoutEffect(() => {
    let loadedDocId: string | undefined;

    if ("namespace" in args) {
      client
        ?.getDoc(args)
        .then((loadedDoc) => {
          loadedDocId = loadedDoc.root.id;
          setDoc(loadedDoc);
        })
        .catch(console.error);
    } else {
      client
        ?.getDoc(args)
        .then((loadedDoc) => {
          loadedDocId = loadedDoc?.root.id;
          setDoc(loadedDoc);
        })
        .catch(console.error);
    }

    return () => {
      const idToUnload = argsId ?? loadedDocId;
      if (idToUnload) client?._unloadDoc(idToUnload).catch(console.error);
    };
  }, [client, argsId]);

  return doc;
}

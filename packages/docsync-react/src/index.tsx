"use client";

import type React from "react";
import { createContext, use, useLayoutEffect, useState } from "react";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
} from "@docnode/docsync/client";
import { type DocBinding } from "@docnode/docsync";

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
  config: T,
) {
  type D = InferD<T>;
  type S = InferS<T>;
  type O = InferO<T>;

  // can't do this safely because can run on server during SSR
  // const client = new DocSyncClient(config as ClientConfig<D, S, O>);

  const DocSyncClientContext = createContext<
    DocSyncClient<D, S, O> | undefined
  >(undefined);

  function DocSyncClientProvider({ children }: { children: React.ReactNode }) {
    const [client, setClient] = useState<DocSyncClient<D, S, O> | undefined>(
      undefined,
    );

    useLayoutEffect(() => {
      setClient(new DocSyncClient(config as ClientConfig<D, S, O>));
    }, []);

    return (
      <DocSyncClientContext value={client}>{children}</DocSyncClientContext>
    );
  }

  type DocResult = { doc: D; id: string } | { doc: undefined; id: undefined };

  function useDoc(args: {
    namespace: string;
    id?: string;
    createIfMissing: true;
  }): DocResult;
  function useDoc(args: {
    namespace: string;
    id: string;
    createIfMissing?: false;
  }): DocResult;
  function useDoc(args: GetDocArgs): DocResult {
    const [result, setResult] = useState<DocResult>({
      doc: undefined,
      id: undefined,
    });
    const client = use(DocSyncClientContext);

    // Use the provided id, or the loaded doc's id for cleanup
    const argsId = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;

    const namespace = args.namespace;

    // The reason why I can't just `return client?.getDoc(args)` is because I get error
    // "async/await is not YET supported in Client Components". Maybe in the future.
    useLayoutEffect(() => {
      let loadedDocId: string | undefined;

      // TODO: fix getDoc return type
      const handleResult = (res: { doc: D; id: string } | undefined) => {
        setResult(res ?? { doc: undefined, id: undefined });
      };

      if (createIfMissing) {
        const getDocArgs = argsId
          ? { namespace, id: argsId, createIfMissing: true as const }
          : { namespace, createIfMissing: true as const };
        client?.getDoc(getDocArgs).then(handleResult).catch(console.error);
      } else if (argsId) {
        client
          ?.getDoc({ namespace, id: argsId })
          .then(handleResult)
          .catch(console.error);
      }

      return () => {
        const idToUnload = argsId ?? loadedDocId;
        if (idToUnload) client?._unloadDoc(idToUnload).catch(console.error);
      };
    }, [client, argsId, namespace, createIfMissing]);

    return result;
  }

  return {
    DocSyncClientContext,
    DocSyncClientProvider,
    useDoc,
  };
}

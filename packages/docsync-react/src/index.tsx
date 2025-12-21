"use client";

import type React from "react";
import { createContext, use, useLayoutEffect, useState } from "react";
import {
  DocSyncClient,
  type ClientConfig,
  type GetDocArgs,
  type QueryResult,
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

  type DocData = { doc: D; id: string };

  function useDoc(args: {
    namespace: string;
    createIfMissing: true;
    id?: string;
  }): QueryResult<DocData>;
  function useDoc(args: {
    namespace: string;
    id: string;
    createIfMissing?: false;
  }): QueryResult<DocData | undefined>;
  function useDoc(args: GetDocArgs): QueryResult<DocData | undefined> {
    const [result, setResult] = useState<QueryResult<DocData | undefined>>({
      status: "loading",
      data: undefined,
      error: undefined,
    });
    const client = use(DocSyncClientContext);
    const id = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    const namespace = args.namespace;

    useLayoutEffect(() => {
      if (!client) return;
      return client.getDoc(args, setResult);
    }, [client, id, namespace, createIfMissing]);

    return result;
  }

  return {
    DocSyncClientContext,
    DocSyncClientProvider,
    useDoc,
  };
}

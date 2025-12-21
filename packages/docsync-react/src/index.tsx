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

  function useDoc(args: GetDocArgs): QueryResult<D> {
    const [result, setResult] = useState<QueryResult<D>>({
      status: "loading",
      data: undefined,
      error: undefined,
    });
    const client = use(DocSyncClientContext);
    const argsId = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    const namespace = args.namespace;

    useLayoutEffect(() => {
      if (!client) return;
      const getDocArgs = createIfMissing
        ? argsId
          ? { namespace, id: argsId, createIfMissing: true as const }
          : { namespace, createIfMissing: true as const }
        : argsId
          ? { namespace, id: argsId }
          : undefined;
      if (!getDocArgs) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return client.getDoc(getDocArgs, (res: QueryResult<any>) => {
        if (res.status === "success")
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          setResult({
            status: "success",
            data: res.data?.doc,
            error: undefined,
          });
        else if (res.status === "error") setResult(res);
      });
    }, [client, argsId, namespace, createIfMissing]);

    return result;
  }

  return {
    DocSyncClientContext,
    DocSyncClientProvider,
    useDoc,
  };
}

import {
  isExistingGetDocData,
  isGetDocData,
} from "../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../index.js";
import { getDocKey } from "../queries/getDoc/getDocKey.js";

export type CreateDocArgs = { type: string; id: string };

export const createDoc = <D extends object, S extends object, O extends object>(
  docSync: DocSyncClient<D, S, O>,
  args: CreateDocArgs,
) => {
  const { queryClient, docBinding } = docSync.config;

  const existingData = queryClient.getQueryData(getDocKey(args));
  if (isExistingGetDocData(existingData, docBinding))
    return Promise.resolve(existingData);
  if (existingData !== undefined && !isGetDocData(existingData))
    return Promise.reject(new Error("Invalid getDoc query data"));

  if (!docBinding)
    return Promise.reject(
      new Error("DocSyncClient requires docBinding to create docs"),
    );

  const { doc, docId } = docBinding.create(args.type, args.id);
  const data = { docId, doc };

  queryClient.setQueryData(getDocKey(args), data);

  return Promise.resolve(data);
};

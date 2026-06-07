import {
  isExistingGetDocData,
  isGetDocData,
} from "../../shared/validators/getDocData.js";
import type { NonNullableValue } from "../../shared/types.js";
import type { DocSync2Client } from "../index.js";
import { getDocKey } from "../queries/getDoc/getDocKey.js";

export type CreateDocArgs = { type: string; id: string };

export const createDoc = <
  D extends NonNullableValue,
  S extends NonNullableValue,
  O extends NonNullableValue,
>(
  docSync: DocSync2Client<D, S, O>,
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
      new Error("DocSync2Client requires docBinding to create docs"),
    );

  const { doc, docId } = docBinding.create(args.type, args.id);
  const data = { docId, doc };

  queryClient.setQueryData(getDocKey(args), data);

  return Promise.resolve(data);
};

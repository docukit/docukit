import { notImplemented } from "../../shared/notImplemented.js";
import type { DocQueryData, DocQueryKey } from "../../shared/types.js";

export type DocQueryArgs = { type: string; id: string };

export type DocQueryOptions<D extends object = object> = {
  queryKey: DocQueryKey;
  queryFn: () => Promise<DocQueryData<D>>;
};

export function docQuery<D extends object = object>(
  args: DocQueryArgs,
): DocQueryOptions<D> {
  return {
    queryKey: ["docukit", "docsync2", "doc", args.type, args.id],
    queryFn: () => Promise.reject(notImplemented()),
  };
}

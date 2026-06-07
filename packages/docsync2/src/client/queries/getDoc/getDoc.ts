import { getDocKey } from "./getDocKey.js";

export type GetDocArgs = { type: string; id: string };

export function getDoc(args: GetDocArgs) {
  return {
    queryKey: getDocKey(args),
    // TODO: Replace this placeholder with the real server/provider load.
    // The real queryFn must not let a manual refetch overwrite an existing
    // in-memory doc with `undefined`.
    queryFn: () => Promise.resolve({ docId: args.id, doc: undefined }),
  };
}

export type GetDocOptions = ReturnType<typeof getDoc>;

import {
  isGetDocKey,
  type GetDocKey,
} from "../../../shared/validators/getDocKey.js";

export type GetDocKeyArgs = { type: string; id: string };

export const getDocKey = ({ type, id }: GetDocKeyArgs): GetDocKey => [
  "docsync2",
  "doc",
  type,
  id,
];

export const getDocArgsFromKey = (
  queryKey: unknown,
): GetDocKeyArgs | undefined => {
  if (!isGetDocKey(queryKey)) return undefined;

  const [, , type, id] = queryKey;
  return { type, id };
};

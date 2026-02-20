import type { UnsubscribeDocRequest } from "../../../shared/types.js";
import type { DocSyncClient } from "../../index.js";

export const handleUnsubscribeDoc = async (
  client: DocSyncClient<object, object>,
  payload: UnsubscribeDocRequest,
): Promise<void> => {
  if (!client["_socket"].connected) return;
  await client["_request"]("unsubscribe-doc", payload);
};

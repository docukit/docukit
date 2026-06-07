import type { QueryCacheNotifyEvent } from "@tanstack/query-core";
import type { DocBinding, NonNullableValue } from "../../../shared/types.js";
import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import { getDocArgsFromKey } from "../../queries/getDoc/getDocKey.js";

export const disposeRemovedGetDocQuery = <D extends NonNullableValue>(
  docBinding: DocBinding<D> | undefined,
  event: QueryCacheNotifyEvent,
): void => {
  // Maybe DocSync2Client should eventually own the QueryCache subscription
  // disposer directly. For now, setupQueryClient registers it on the client
  // "dispose" event so the constructor does not need a dead property.
  if (event.type !== "removed") return;
  if (!getDocArgsFromKey(event.query.queryKey)) return;
  if (!docBinding) return;

  const data: unknown = event.query.state.data;
  if (!isExistingGetDocData(data, docBinding)) return;

  docBinding.dispose(data.doc);
};

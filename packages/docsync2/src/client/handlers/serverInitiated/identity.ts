import type { DocSyncClient } from "../../index.js";
import { saveLocalIdentity } from "../../utils/localIdentity.js";

export function handleIdentity<
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("identity", (payload) => {
    const identity = { userId: payload.userId };

    void client["_localPromise"].then((local) => {
      if (local.identity.userId === identity.userId) {
        saveLocalIdentity(identity);
      }
    });
  });
}

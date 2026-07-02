import type { DocSyncClient } from "../index.js";
import type { ClientConfig, ClientProvider, Identity } from "../types.js";
import { BCHelper } from "./BCHelper.js";
import { saveLocalIdentity } from "./localIdentity.js";

type ResolvedLocal<S extends object, O extends object> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};

export const setupLocalPromise = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
  providerFactory,
  cachedIdentity,
}: {
  client: DocSyncClient<D, S, O>;
  providerFactory: ClientConfig<D, S, O>["local"]["provider"];
  cachedIdentity: Identity | undefined;
}): Promise<ResolvedLocal<S, O>> => {
  if (cachedIdentity) {
    client["_bcHelper"]?.close();
    client["_bcHelper"] = new BCHelper(client, cachedIdentity.userId);
    return Promise.resolve({
      provider: providerFactory(cachedIdentity),
      identity: cachedIdentity,
    });
  }

  return new Promise((resolve) => {
    let didResolve = false;
    client["_socket"].on("identity", (payload) => {
      if (didResolve) return;
      didResolve = true;

      const identity = { userId: payload.userId };
      saveLocalIdentity(identity);
      client["_bcHelper"]?.close();
      client["_bcHelper"] = new BCHelper(client, identity.userId);
      resolve({ provider: providerFactory(identity), identity });
    });
  });
};

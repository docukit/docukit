import type { DocSyncClient } from "../index.js";
import type { ClientConfig, ClientProvider, Identity } from "../types.js";
import { BCHelper } from "./BCHelper.js";
import { saveLocalIdentity } from "./localIdentity.js";

type ResolvedLocal<S extends object, O extends object> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};

export const setupLocalPromise = async <
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
  cachedIdentity: Promise<Identity | undefined>;
}): Promise<ResolvedLocal<S, O>> => {
  // Register before awaiting IDB so a fast handshake cannot lose identity.
  const serverIdentity = new Promise<Identity>((resolve) => {
    client["_socket"].on("identity", (payload) => {
      resolve({ userId: payload.userId });
    });
  });
  const cached = await cachedIdentity;
  const identity = cached ?? (await serverIdentity);
  if (!cached) await saveLocalIdentity(identity);
  client["_bcHelper"] = new BCHelper(client, identity.userId);
  return { provider: providerFactory(identity), identity };
};

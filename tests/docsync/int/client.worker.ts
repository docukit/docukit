import { defineNode, string } from "@docukit/docnode";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { DocSyncCore, indexedDBProvider } from "@docukit/docsync/core";

const ChildNode = defineNode({ type: "child", state: { value: string("") } });

self.addEventListener(
  "message",
  (
    event: MessageEvent<{
      token: string;
      docId: string;
      serverUrl: string;
      offline?: boolean;
      edit?: string;
    }>,
  ) => {
    const { token, docId, serverUrl, offline, edit } = event.data;
    // Shared/service workers do not have animation frames. Exercise that capability boundary.
    if (edit) Reflect.set(globalThis, "requestAnimationFrame", undefined);
    const client = new DocSyncCore({
      server: {
        url: serverUrl,
        auth: { mode: "token", getToken: () => token },
      },
      local: { provider: indexedDBProvider },
      docBinding: DocNodeBinding([
        { type: "test", extensions: [{ nodes: [ChildNode] }] },
      ]),
    });
    if (offline) client.disconnect();
    let finished = false;
    const unsubscribe = client.subscribeDoc(
      { type: "test", id: docId },
      (snapshot) => {
        if (finished || snapshot.status === "pending") return;
        if (
          snapshot.status === "success" &&
          snapshot.fetchStatus !== (offline ? "paused" : "idle")
        )
          return;
        finished = true;
        const finish = async () => {
          if (edit && snapshot.data) {
            const doc = snapshot.data.doc;
            const child = doc.createNode(ChildNode);
            child.state.value.set(edit);
            doc.root.append(child);
            doc.forceCommit();
            await client.flush(docId);
            if (!offline) await client["_sync"](docId);
          }
          self.postMessage({
            status: snapshot.status,
            error: snapshot.error?.message,
            docId: snapshot.data?.docId,
            hasWindow: typeof window !== "undefined",
            hasLocalStorage: typeof localStorage !== "undefined",
          });
          unsubscribe();
          client.disconnect();
        };
        queueMicrotask(() => {
          void finish().catch((error: unknown) =>
            self.postMessage({ error: String(error) }),
          );
        });
      },
    );
  },
  { once: true },
);

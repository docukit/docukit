import { defineNode, string } from "@docukit/docnode";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { DocSyncCore, indexedDBProvider } from "@docukit/docsync/core";

const enteredAt = performance.timeOrigin + performance.now();
const ChildNode = defineNode({ type: "child", state: { value: string("") } });

self.addEventListener(
  "message",
  (
    event: MessageEvent<{
      token: string;
      docId: string;
      serverUrl: string;
      startedAt: number;
    }>,
  ) => {
    const { token, docId, serverUrl, startedAt } = event.data;
    const now = () => performance.timeOrigin + performance.now() - startedAt;
    Reflect.set(globalThis, "requestAnimationFrame", undefined);
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
    client.disconnect();
    let syncRequests = 0;
    client["_socket"].onAnyOutgoing((event) => {
      if (event === "sync") syncRequests++;
    });
    let localReadyMs: number | undefined;
    let finished = false;
    client.subscribeDoc({ type: "test", id: docId }, (snapshot) => {
      if (finished || snapshot.status === "pending") return;
      if (snapshot.status === "error" || !snapshot.data) {
        finished = true;
        self.postMessage({
          error: snapshot.error?.message ?? "Missing local document",
        });
        return;
      }
      if (localReadyMs === undefined) {
        localReadyMs = now();
        const doc = snapshot.data.doc;
        const child = doc.createNode(ChildNode);
        child.state.value.set("benchmark edit");
        doc.root.append(child);
        doc.forceCommit();
        void client
          .flush(docId)
          .then(() => client.connect())
          .catch((error: unknown) =>
            self.postMessage({ error: String(error) }),
          );
      } else if (snapshot.fetchStatus === "idle") {
        finished = true;
        self.postMessage({
          workerEntryMs: enteredAt - startedAt,
          localReadyMs,
          syncReadyMs: now(),
          syncRequests,
        });
      }
    });
  },
  { once: true },
);

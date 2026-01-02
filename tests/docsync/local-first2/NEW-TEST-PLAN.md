We are going to make a new test plan that is simpler and easier to understand than ../local-first/REALTIME-TEST-PLAN.md.

We are going to replicate the 2 real scenarios that can happen in practice: otherTab and otherDevice.

| client/doc  | broadcastChannel | realTime | idb |
| ----------- | ---------------- | -------- | --- |
| reference   | N/A              | N/A      | N/A |
| otherTab    | ✅               | ✅       | ✅  |
| otherDevice | ❌               | ✅       | ❌  |

**Note:** `otherDevice` uses a different userId, which automatically means:

- Different IDB namespace (won't share IndexedDB with reference/otherTab)
- Different BC namespace (won't receive BroadcastChannel messages)

Each test will use a wrapper function that initializes 3 pairs of clients/documents, runs the test, and cleans up automatically.
The 3 clients will connect to the same document.

- Reference: client should have local, RT and BC enabled (userId1).
- OtherTab: client should have local, RT and BC enabled (same userId1 as reference).
- OtherDevice: client should have local enabled but with different userId2, RT enabled, BC disabled.

```ts
type ClientUtils = {
  client: DocSyncClient;
  doc: Doc | undefined;
  loadDoc: () => Promise<void>;
  unLoadDoc: () => void;
  addChild: (text: string) => void;
  assertIDBDoc: (children: string[]) => Promise<void>;
  assertMemoryDoc: (children: string[]) => void;
};

type ClientsSetup = {
  docId: string;
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherDevice: ClientUtils;
};

// Wrapper that handles setup and cleanup
testWrapper(callback: (clients: ClientsSetup) => Promise<void>): Promise<void>;
```

Example of a test:

```ts
test("otherTab receives changes via BroadcastChannel", async () => {
  await testWrapper(async (clients) => {
    await clients.reference.loadDoc();
    await clients.otherTab.loadDoc();

    clients.otherTab.addChild("Hello");

    await clients.reference.assertIDBDoc(["Hello"]);
    await clients.otherTab.assertIDBDoc(["Hello"]);
  });
  // Cleanup happens automatically!
});
```

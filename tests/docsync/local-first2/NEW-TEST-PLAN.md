We are going to make a new test plan that is simpler and easier to understand than ../local-first/REALTIME-TEST-PLAN.md.

We are going to replicate the 3 real scenarios that can happen in practice: otherTab, otherTabAndUser, otherDevice.

| client/doc      | broadcastChannel | realTime | idb |
| --------------- | ---------------- | -------- | --- |
| reference       | N/A              | N/A      | N/A |
| otherTab        | ✅               | ✅       | ✅  |
| otherTabAndUser | ✅ (no messages) | ✅       | ✅  |
| otherDevice     | ❌               | ✅       | ❌  |

Each test will use a wrapper function that initializes 4 pairs of clients/documents, runs the test, and cleans up automatically.
The 4 clients will connect to the same document.

- Reference: client should have local, RT y BC enabled.
- OtherTab: client should have local, RT y BC enabled (same userId as reference).
- OtherTabAndUser: client should have local, RT y BC enabled (different userId - won't receive BC messages due to namespacing).
- OtherDevice: client should NOT have local. BC should be disabled y RT enabled.

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
  otherTabAndUser: ClientUtils;
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

We are going to make a new test plan that is simpler and easier to understand than ../local-first/REALTIME-TEST-PLAN.md.

We are going to replicate the 3 real scenarios that can happen in practice: otherTab, otherTabAndUser, otherDevice.

| client/doc      |  broadcastChannel |  realTime | idb |
| --------------- | ----------------- | --------- | --- |
| reference       | N/A               | N/A       | N/A |
| otherTab        | ✅                | ✅        | ✅  |
| otherTabAndUser | ❌                | ✅        | ✅  |
| otherDevice     | ❌                | ✅        | ❌  |

Each test will start with a utility function that initializes 4 pairs of clients/documents.
The 4 clients will connect to the same document.

```ts
type ClientUtils = {
  client: DocSyncClient;
  doc: Doc | undefined;
  loadDoc: () => Promise<void>;
  unLoadDoc: () => void;
  addChild: (text: string) => void;
  assertIDBDoc: (children: string[]) => void;
  assertMemoryDoc: (children: string[]) => void;
};

type D = {
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherTabAndUser: ClientUtils;
  otherDevice: ClientUtils;
};
```

Example of a test:

```ts
test("otherTab", async () => {
  const d = await createD();
  await d.reference.loadDoc();
  await d.otherTab.loadDoc();
  await d.otherTab.addChild("Hello");
  await d.reference.assertIDBDoc(["Hello"]);
  await d.otherTab.assertIDBDoc(["Hello"]);
});
```

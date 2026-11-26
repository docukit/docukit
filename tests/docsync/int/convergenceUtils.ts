import type { Doc, DocNode } from "@docukit/docnode";
import { expect } from "vitest";
import { ChildNode, type testWrapper } from "./utils.js";

type Clients = Parameters<Parameters<typeof testWrapper>[0]>[0];
type Device = Clients["reference"];
type SlowRequest = ReturnType<Device["holdNextSyncRequest"]>;

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Small deterministic PRNG, so a failing history can be replayed by seed. */
const createRandom = (seed: number) => {
  let state = seed;
  return (max: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
};

const liveDoc = (device: Device) => {
  const doc = device.doc;
  if (!doc) throw new Error("Doc not loaded");
  return doc;
};

/** Commits one edit of the device's live doc on its own, as a user would. */
const edit = (device: Device, change: (doc: Doc) => void) => {
  const doc = liveDoc(device);
  change(doc);
  doc.forceCommit();
};

const createChild = (doc: Doc, text: string) => {
  const child = doc.createNode(ChildNode);
  child.state.value.set(text);
  return child;
};

export const prependChild = (device: Device, text: string) => {
  edit(device, (doc) => doc.root.prepend(createChild(doc, text)));
};

/**
 * One random edit of the list of children. Most of them depend on the order
 * they are applied in, which is what tells a rebased doc apart from one that
 * applied remote operations on top of its own.
 */
const randomEdit = (
  device: Device,
  random: (max: number) => number,
  text: string,
) => {
  edit(device, (doc) => {
    const nodes: DocNode<typeof ChildNode>[] = [];
    doc.root.children().forEach((node) => {
      if (node.is(ChildNode)) nodes.push(node);
    });
    const node = nodes[random(nodes.length)];
    if (!node) {
      doc.root.prepend(createChild(doc, text));
      return;
    }
    const action = random(5);
    if (action === 0) doc.root.prepend(createChild(doc, text));
    else if (action === 1) node.insertAfter(createChild(doc, text));
    else if (action === 2) node.delete();
    else if (action === 3) node.move(doc.root, "prepend");
    else node.state.value.set(text);
  });
};

const serialize = (device: Device, doc = liveDoc(device)) =>
  device.client["_docBinding"].serialize(doc);

/** Nothing left to send: no sync in flight and no pending operation. */
const isSettled = async (device: Device, docId: string) => {
  const client = device.client;
  if (
    !client["_socket"].connected ||
    client["_syncQueue"].size > 0 ||
    client["_localOpsBatchState"].size > 0 ||
    client["_localWrites"].size > 0
  ) {
    return false;
  }
  const { provider } = await client["_localPromise"];
  const pending = await provider.transaction("readonly", (ctx) =>
    ctx.getOperations({ docId }),
  );
  return pending.length === 0;
};

/** The last server batch queued for the device's live doc, if any. */
const streamTail = (device: Device, docId: string) =>
  device.client["_docsCache"].get(docId)?.stream?.tail;

/** Waits until the server batches queued for the live doc are integrated. */
const settleStream = async (device: Device, docId: string) => {
  let tail = streamTail(device, docId);
  for (;;) {
    await tail;
    const next = streamTail(device, docId);
    if (next === tail) return tail;
    tail = next;
  }
};

/**
 * Expects the live doc to be the one the device would show after a reload: its
 * stored copy with its pending operations on top. Skipped while an edit is
 * still on its way to storage, and checked once the server batches already
 * received are integrated: storage takes a batch before the live doc does.
 */
const expectLiveDocToMatchStorage = async (device: Device, docId: string) => {
  const client = device.client;
  const { provider } = await client["_localPromise"];
  const tail = await settleStream(device, docId);
  const [stored, pending] = await provider.transaction("readonly", (ctx) =>
    Promise.all([
      ctx.getSerializedDoc({ docId }),
      ctx.getOperations({ docId }),
    ]),
  );
  if (
    !stored ||
    streamTail(device, docId) !== tail ||
    client["_localOpsBatchState"].has(docId) ||
    client["_localWrites"].has(docId)
  ) {
    return;
  }
  const binding = client["_docBinding"];
  const reloaded = binding.deserialize(stored.serializedDoc);
  for (const batch of pending) {
    for (const operations of batch.operations) {
      binding.applyOperations(reloaded, operations);
    }
  }
  expect(serialize(device)).toStrictEqual(serialize(device, reloaded));
};

/**
 * Connecting a socket that is still connecting sends a second handshake, and
 * the server drops the connection for it. That is unrelated to convergence.
 */
const connectIfIdle = (device: Device) => {
  if (!device.client["_socket"].active) device.connect();
};

/**
 * Waits until no device has anything left to send, then loads the document
 * from the server on a new device and expects every live doc to match it.
 */
export const expectLiveDocsToMatchServer = async (
  clients: Clients,
  devices: Device[],
) => {
  for (const device of devices) connectIfIdle(device);
  await expect
    .poll(async () => {
      const settled = await Promise.all(
        devices.map((device) => isSettled(device, clients.docId)),
      );
      return settled.every(Boolean);
    })
    .toBe(true);
  const server = await clients.addNewDevice();
  await server.loadDoc({ createIfMissing: false });
  const expected = serialize(server);
  for (const device of devices) {
    await expect.poll(() => serialize(device)).toStrictEqual(expected);
  }
};

/** Whether the device subscribed to the document on its current connection. */
const isSubscribed = (device: Device, docId: string) =>
  device.client["_docsCache"].get(docId)?.stream?.generation ===
  device.client["_connectionGeneration"];

/**
 * Waits until a connected device has subscribed on its current connection and
 * reconciled the response. Two races of a subscription are tracked in issue
 * #97 and kept out of these histories: an edit made while it is on the wire
 * or being reconciled can end up in a different order than the server's, and
 * a connection dropped while it is reconciled leaves the live doc behind
 * storage until the next subscription.
 */
export const waitForOwnSubscription = async (device: Device, docId: string) => {
  if (!device.client["_socket"].connected) return;
  await expect.poll(() => isSubscribed(device, docId)).toBe(true);
  await settleStream(device, docId);
};

/**
 * Two devices edit the same document at random while their connections come
 * and go. A device can also send a sync request that stays on the wire for a
 * few steps, like a slow uplink, so the server pushes remote operations while
 * the device keeps editing on top of a batch it has not had confirmed. After
 * every step each live doc must match what its device would load after a
 * reload, and at the end, what the server has.
 */
export const runRandomHistory = async (clients: Clients, seed: number) => {
  const random = createRandom(seed);
  const devices = [clients.reference, clients.otherDevice];
  const slowRequests = new Map<Device, SlowRequest>();
  for (const device of devices) {
    await device.loadDoc();
    // Sync after almost every edit, so syncs keep overlapping with edits.
    device.client["_collabMaxDebounce"] = random(10);
    device.client["_singleClientMaxDebounce"] = random(10);
  }
  for (const device of devices) {
    await expect.poll(() => isSettled(device, clients.docId)).toBe(true);
  }

  for (let step = 0; step < 40; step++) {
    const index = random(devices.length);
    const device = devices[index];
    if (!device) throw new Error("No device");
    const action = random(8);
    if (action === 0) {
      if (device.client["_socket"].connected) {
        await waitForOwnSubscription(device, clients.docId);
        // A request cannot outlive its connection, so it lands before the drop.
        slowRequests.get(device)?.restore();
        slowRequests.delete(device);
        device.disconnect();
      } else {
        connectIfIdle(device);
      }
    } else if (action === 1) {
      const slowRequest = slowRequests.get(device);
      slowRequests.delete(device);
      if (slowRequest) {
        slowRequest.restore();
      } else if (isSubscribed(device, clients.docId)) {
        // Sync right away, as a new edit would, and keep the request on the
        // wire while both devices keep editing. A subscription is not held:
        // see `waitForOwnSubscription`.
        slowRequests.set(device, device.holdNextSyncRequest());
        void device.client["_sync"](clients.docId);
      }
    } else {
      await waitForOwnSubscription(device, clients.docId);
      randomEdit(device, random, `${index}:${step}`);
    }
    await tick(random(8));
    for (const peer of devices) {
      await expectLiveDocToMatchStorage(peer, clients.docId);
    }
  }

  for (const slowRequest of slowRequests.values()) slowRequest.restore();
  await expectLiveDocsToMatchServer(clients, devices);
};

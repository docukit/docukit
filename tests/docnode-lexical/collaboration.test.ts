import { describe, expect, test } from "vitest";

import { randomizer } from "../docnode/text/utils.js";
import {
  $deleteAt,
  $enterAt,
  $insertParagraphsAt,
  $joinWithPrevious,
  $typeAt,
  createPeers,
  createTwoPeers,
  loadedTexts,
  type Peer,
} from "./utils.js";

/** The editor shows exactly what the peer's document holds. */
function expectInSync(peer: Peer) {
  expect(peer.texts()).toStrictEqual(loadedTexts(peer.doc));
}

describe("an editor never drifts from its document", () => {
  test("typing right after an undo that only restored the selection", () => {
    const [peer] = createPeers(["Hello", "World"], 1).peers as [Peer];
    peer.update(() => $typeAt(1, 1, "X"));
    peer.undo();
    peer.update(() => $typeAt(0, 5, "ab"));
    peer.undo();
    peer.update(() => $typeAt(1, 3, "X"));
    expectInSync(peer);
    expect(loadedTexts(peer.doc)).toStrictEqual(["Hello", "WorXld"]);
  });

  test("typing right after a remote change that changed nothing visible", () => {
    const { peers, sync, send, receive } = createPeers(["Hello", "World"]);
    const [a, b] = peers as [Peer, Peer];
    a.update(() => $deleteAt(1, 0));
    b.update(() => $deleteAt(1, 0));
    send(a);
    send(b);
    // `b`'s delete reaches `a`, which had already deleted the same letter.
    receive(a);
    a.update(() => $typeAt(1, 0, "X"));
    expectInSync(a);
    sync();
    for (const peer of peers)
      expect(peer.texts()).toStrictEqual(["Hello", "Xorld"]);
  });

  test("two peers join the same paragraph and one undoes: typing in it", () => {
    const { peers, sync, server } = createPeers(["Hello", "World"]);
    const [a, b] = peers as [Peer, Peer];
    a.update(() => $joinWithPrevious(1));
    b.update(() => $joinWithPrevious(1));
    sync();
    a.undo();
    sync();
    // The paragraph is back with its text, though `b` joined it too.
    expect(a.texts()).toStrictEqual(["Hello", "World"]);
    a.update(() => $typeAt(1, 0, "X"));
    sync();
    for (const peer of peers) {
      expectInSync(peer);
      expect(peer.texts()).toStrictEqual(["Hello", "XWorld"]);
    }
    expect(loadedTexts(server)).toStrictEqual(["Hello", "XWorld"]);
  });
});

describe("random editing sessions", () => {
  /** One random step of one peer, decided only by `rng`. */
  function step(
    network: ReturnType<typeof createPeers>,
    rng: ReturnType<typeof randomizer>,
  ) {
    const peer = network.peers[rng.int(2)]!;
    const paragraphs = peer.texts().length;
    const index = rng.int(paragraphs);
    const offset = rng.int(8);
    const roll = rng.next();
    if (roll < 0.3)
      peer.update(() => $typeAt(index, offset, rng.pick(["X", "ab"])));
    else if (roll < 0.4) peer.update(() => $enterAt(index, offset));
    else if (roll < 0.52 && index > 0)
      peer.update(() => $joinWithPrevious(index));
    else if (roll < 0.6) peer.update(() => $deleteAt(index, offset));
    else if (roll < 0.7) peer.undo();
    else if (roll < 0.75) peer.redo();
    else if (roll < 0.88) network.send(peer);
    else network.receive(peer);
  }

  test.each(Array.from({ length: 30 }, (_, seed) => seed))(
    "seed %i: every editor shows its document, and text states converge",
    (seed) => {
      const rng = randomizer(seed);
      const network = createPeers(["Hello", "World", "Third line"]);
      for (let i = 0; i < 40; i++) step(network, rng);
      network.sync();
      for (const peer of network.peers) expectInSync(peer);
      // Undoing a delete only agrees with a peer's concurrent delete of the
      // same letters in the server's order: every peer takes its document.
      network.syncAsDocSync();
      for (const peer of network.peers) {
        expectInSync(peer);
        expect(peer.doc.root.toJSON()).toStrictEqual(
          network.server.root.toJSON(),
        );
      }
    },
  );
});

describe("edits in repeated text", () => {
  test("a copy pasted before the original keeps a peer's edit in the original", () => {
    const { peers, sync } = createPeers(["cat dog"]);
    const [a, b] = peers as [Peer, Peer];
    a.update(() => $typeAt(0, 0, "cat dog "));
    b.update(() => $typeAt(0, 3, " X"));
    sync();
    for (const peer of peers)
      expect(peer.texts()).toStrictEqual(["cat dog cat X dog"]);
  });

  test("a row typed before identical rows keeps a peer's edit in its row", () => {
    const { peers, sync } = createPeers(["item; item; "]);
    const [a, b] = peers as [Peer, Peer];
    a.update(() => $typeAt(0, 0, "item; "));
    b.update(() => $typeAt(0, 10, "!"));
    sync();
    for (const peer of peers)
      expect(peer.texts()).toStrictEqual(["item; item; item!; "]);
  });
});

describe("undo, after a peer added paragraphs above", () => {
  test("puts the caret back in the paragraph and offset of the edit", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const { a, b, sync } = createTwoPeers(lines);
    a.select(9, 2);
    a.update(() => $typeAt(9, 2, "XYZ"));
    sync();
    b.update(() => $insertParagraphsAt(0, ["new 0", "new 1", "new 2"]));
    sync();
    a.undo();
    expect(a.textsWithCaret()).toStrictEqual([
      "new 0",
      "new 1",
      "new 2",
      ...lines.slice(0, 9),
      "li|ne 9",
      ...lines.slice(10),
    ]);
  });
});

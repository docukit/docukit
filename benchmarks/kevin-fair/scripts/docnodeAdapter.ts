// crdt-benchmarks adapter (AbstractCrdt) for one DocNode tree. Base mode only.
//
// The harness is the network. The "server" is the module-level counter below:
// every update gets the next number when it is emitted (that is the server
// order). The numbering travels out of band (WeakMap), it is not counted in
// bytes. An update a replica receives that it emitted itself is an ack. A
// foreign update that arrives while the replica has own pending updates with a
// later number makes the replica rebase: it rebuilds from its confirmed
// snapshot (the server's state), applies the server's batches up to the
// foreign one, and then its own pending batches again. That cost is part of the
// time of B2/B3.
//
// Array = children of the root (state `v` of each item). Map = root state `b`.
// Text = root state `t`: `text()` (milestone 2) or the older `defineText()`, only where the tree exports one.
import * as DN from "@docukit/docnode";

const { Doc, defineNode, defineState } = DN as any;
const defineText = ((DN as any).text ?? (DN as any).defineText) as
  | undefined
  | (() => unknown);
const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";

const value = defineState({
  fromJSON: (json: unknown) => (json === undefined ? null : json),
});
const Item = defineNode({ type: "i", state: { v: value } });
const Root = defineNode({
  type: "root",
  state: defineText ? { b: value, t: defineText() } : { b: value },
});

const config = () => ({
  type: "root",
  id: ROOT_ID,
  extensions: [{ nodes: [Root, Item] }],
});

const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------ emulated server
// The emulated server. All the rows run in one process (like upstream), so each
// row gets a new one: a document created after some document was saved
// starts a new server, and the old log can be collected.
type Server = { seq: number; log: Uint8Array[] };
let server: Server = { seq: 0, log: [] };
let savedSinceCreate = false;
// Each update carries its number and author in a symbol property. A WeakMap kept every update of B4 (260,000) as an
// entry, and growing it copied all of them inside the next row's window: B1.2 time read ~5 ms instead of ~0.1 ms
// (2026-11-28). Yjs runs without this adapter, so it never paid that.
const META = Symbol("server");
type Meta = { seq: number; author: DocNodeCrdt };
// The server's log, in its order (it stores and forwards; it builds no doc).

export class DocNodeCrdt {
  doc: any;
  private inTransact = false;
  private dirty = false;
  // Own batches the server numbered, not yet acked to this client.
  private pending: { seq: number; update: Uint8Array }[] = [];
  // The server's state up to `confirmedUpTo` (exclusive), as the encoded JSON
  // (what this replica loaded, or what its last rebase produced);
  // undefined = the empty document.
  private confirmed: Uint8Array | undefined;
  private confirmedUpTo = 0;
  private server!: Server;
  private applying = false;
  private itemsCache: any[] | undefined;

  constructor(
    private readonly updateHandler: (u: Uint8Array) => void,
    init?: Uint8Array,
  ) {
    this.doc =
      init === undefined
        ? new Doc(config())
        : Doc.fromJSON(config(), JSON.parse(dec.decode(init)));
    this.doc.forceCommit();
    if (init !== undefined) this.confirmed = init;
    // The server log is shared by every document in the process (all the rows
    // run in one process, like upstream): this one starts where it is now.
    if (init === undefined && savedSinceCreate) {
      server = { seq: 0, log: [] };
      savedSinceCreate = false;
    }
    this.server = server;
    this.confirmedUpTo = server.seq;
    this.listen();
  }

  private listen() {
    this.doc.onChange((event: any) => {
      if (this.applying || event.flags?.skipUndo) return;
      const update = enc.encode(JSON.stringify(event.operations));
      const seq = this.server.seq++;
      const numbered: Meta = { seq, author: this };
      Reflect.set(update, META, numbered);
      this.server.log.push(update);
      this.pending.push({ seq, update });
      this.updateHandler(update);
    });
  }

  private commit() {
    if (this.inTransact) this.dirty = true;
    else this.doc.forceCommit();
  }

  private applyRemote(ops: unknown) {
    this.applying = true;
    try {
      this.doc.applyOperations(ops, { skipUndo: true });
      this.doc.forceCommit();
    } finally {
      this.applying = false;
    }
  }

  applyUpdate(update: Uint8Array) {
    if (this.inTransact && this.dirty) {
      this.doc.forceCommit();
      this.dirty = false;
    }
    this.itemsCache = undefined;
    const m: Meta | undefined = Reflect.get(update, META);
    if (m === undefined) throw new Error("unknown update");
    // In-order delivery: everything this client sent before m.seq is acked.
    while (this.pending.length && this.pending[0]!.seq < m.seq)
      this.pending.shift();
    if (m.author === this) {
      if (this.pending.length && this.pending[0]!.seq === m.seq)
        this.pending.shift();
      return;
    }
    const ops = JSON.parse(dec.decode(update));
    if (this.pending.length === 0) {
      this.applyRemote(ops);
      return;
    }
    // Rebase: the server's state (snapshot plus the batches ordered since, up
    // to this one), then our pending batches again on top.
    this.doc =
      this.confirmed === undefined
        ? new Doc(config())
        : Doc.fromJSON(config(), JSON.parse(dec.decode(this.confirmed)));
    this.doc.forceCommit();
    for (let s = this.confirmedUpTo; s < m.seq; s++)
      this.applyRemote(JSON.parse(dec.decode(this.server.log[s]!)));
    this.applyRemote(ops);
    this.confirmed = enc.encode(JSON.stringify(this.doc.toJSON()));
    this.confirmedUpTo = m.seq + 1;
    for (const p of this.pending)
      this.applyRemote(JSON.parse(dec.decode(p.update)));
    this.listen();
  }

  getEncodedState() {
    savedSinceCreate = true;
    if (this.dirty) {
      this.doc.forceCommit();
      this.dirty = false;
    }
    return enc.encode(JSON.stringify(this.doc.toJSON()));
  }

  transact(f: (c: DocNodeCrdt) => void) {
    if (this.inTransact) return f(this);
    this.inTransact = true;
    try {
      f(this);
    } finally {
      this.inTransact = false;
    }
    if (this.dirty) {
      this.dirty = false;
      this.doc.forceCommit();
    }
  }

  // ----- array
  private items() {
    if (this.itemsCache === undefined) {
      const out: any[] = [];
      this.doc.root.children().forEach((n: any) => out.push(n));
      this.itemsCache = out;
    }
    return this.itemsCache;
  }

  insertArray(index: number, elements: unknown[]) {
    const items = this.items();
    const nodes = elements.map((e) => {
      const n = this.doc.createNode(Item);
      n.state.v.set(e);
      return n;
    });
    if (index === 0) this.doc.root.prepend(...nodes);
    else items[index - 1].insertAfter(...nodes);
    items.splice(index, 0, ...nodes);
    this.commit();
  }

  deleteArray(index: number, length: number) {
    const items = this.items();
    if (length === 1) items[index].delete();
    else items[index].to(items[index + length - 1]).delete();
    items.splice(index, length);
    this.commit();
  }

  getArray() {
    const out: unknown[] = [];
    this.doc.root.children().forEach((n: any) => out.push(n.state.v.get()));
    return out;
  }

  // ----- map
  setMap(key: string, v: unknown) {
    if (key !== "v") throw new Error("only key v");
    this.doc.root.state.b.set(v);
    this.commit();
  }

  getMap() {
    const v = this.doc.root.state.b.get();
    return v === null ? {} : { v };
  }

  // ----- text
  private text() {
    if (!defineText) throw new Error("not supported: no text() on this tree");
    return this.doc.root.state.t;
  }

  insertText(index: number, text: string) {
    this.text().insert(index, text);
    this.commit();
  }

  deleteText(index: number, length: number) {
    this.text().delete(index, length);
    this.commit();
  }

  getText() {
    return this.text().get();
  }

  toString() {
    return this.getText();
  }
}

export class DocNodeFactory {
  create(handler: (u: Uint8Array) => void) {
    return new DocNodeCrdt(handler);
  }
  load(handler: (u: Uint8Array) => void, bin: Uint8Array) {
    return new DocNodeCrdt(handler, bin);
  }
  getName() {
    return "docnode";
  }
}

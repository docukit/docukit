[![Docukit banner](.github/readme-banner.png)](https://docukit.dev)

<p align="center">
  <a href="https://discord.gg/WWCWcphGSJ"><img alt="Discord" src="https://img.shields.io/discord/508357248330760243?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@docukit/docnode"><img alt="npm" src="https://img.shields.io/npm/v/@docukit/docnode?style=flat-square" /></a>
  <a href="https://x.com/docnode"><img alt="X" src="https://img.shields.io/badge/follow-docnode-000000?logo=x&style=flat-square" /></a>
</p>

<p align="center">
  <strong>Build local-first apps with type-safe documents and real-time sync.</strong>
</p>

---

## What is Docukit?

Docukit is a set of libraries for building **local-first** applications: type-safe document models, real-time collaboration, and optional sync backends. Use DocNode for your document layer (with optional [Lexical](https://lexical.dev) bindings) and DocSync when you need multi-client sync over WebSockets.

| Package                                                           | Description                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@docukit/docnode`](https://docukit.dev/docnode)                 | Type-safe document manager (OT/CRDT), undo manager, and schema normalization |
| [`@docukit/docsync`](https://docukit.dev/docsync)                 | CRDT-agnostic sync protocol; works with DocNode, Yjs, Loro, and others       |
| [`@docukit/docnode-lexical`](https://docukit.dev/docnode/lexical) | Bind DocNode to Lexical for rich-text editors and presence                   |

Full docs, comparison tables (DocNode vs Yjs, DocSync vs Hocuspocus), and examples: **[docukit.dev](https://docukit.dev)**.

## Quick start

```bash
npm i @docukit/docnode
```

```ts
import { Doc, defineNode, string } from "@docukit/docnode";

const PageNode = defineNode({
  type: "page",
  state: {
    title: string(""),
    body: string(""),
  },
});

const doc = new Doc({
  type: "page",
  extensions: [{ nodes: [PageNode] }],
});

doc.root.state.title.set("Hello, local-first.");
```

See the [DocNode getting started](https://docukit.dev/docnode/getting-started) and [DocSync getting started](https://docukit.dev/docsync/getting-started) guides for more.

## Why Docukit?

- **Type-safe** — Define nodes and state with TypeScript; get full inference and fewer runtime bugs.
- **Local-first** — Documents live locally; sync when connected. Works offline and scales to real-time.
- **Flexible** — Use DocNode alone, or add DocSync for server-backed sync. DocSync is CRDT-agnostic, so you can pair it with Yjs, Loro, or other CRDTs if you prefer.

## Links

- [Documentation](https://docukit.dev) · [DocNode](https://docukit.dev/docnode) · [DocSync](https://docukit.dev/docsync)
- [Discord](https://discord.gg/WWCWcphGSJ) · [X @docnode](https://x.com/docnode)
- [License](./LICENSE.md)

---

**Contributing / local dev:** `pnpm i` then `pnpm dev`.

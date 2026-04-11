"use client";

export default function HomePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="mb-4 text-4xl font-bold text-white">DocuKit Examples</h1>
        <p className="mb-8 text-lg text-zinc-400">
          Interactive examples showcasing DocSync with different CRDT backends.
          Select an example from the sidebar to get started.
        </p>
        <div className="grid gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-left">
            <h2 className="mb-2 text-xl font-semibold text-white">
              Editor (DocNode)
            </h2>
            <p className="text-zinc-400">
              A Lexical-based rich text editor synced via DocNode CRDT.
              Demonstrates integration with docnode-lexical binding.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-left">
            <h2 className="mb-2 text-xl font-semibold text-white">
              Editor (Yjs)
            </h2>
            <p className="text-zinc-400">
              A Lexical-based rich text editor synced via Yjs CRDT. Demonstrates
              integration with @lexical/yjs CollaborationPlugin.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-left">
            <h2 className="mb-2 text-xl font-semibold text-white">
              Subdocs (DocNode)
            </h2>
            <p className="text-zinc-400">
              Hierarchical document structure with nested navigation and
              real-time sync using DocNode.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-left">
            <h2 className="mb-2 text-xl font-semibold text-white">
              Subdocs (Yjs)
            </h2>
            <p className="text-zinc-400">
              Hierarchical document structure with nested navigation and
              real-time sync using Yjs shared types.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

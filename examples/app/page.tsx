"use client";

export default function HomePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="mb-4 text-4xl font-bold text-white">DocNode Examples</h1>
        <p className="mb-8 text-lg text-zinc-400">
          Interactive examples showcasing DocNode features. Select an example
          from the sidebar to get started.
        </p>
        <div className="grid gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-left">
            <h2 className="mb-2 text-xl font-semibold text-white">Editor</h2>
            <p className="text-zinc-400">
              A Lexical-based rich text editor with formatting toolbar and dark
              theme. Demonstrates integration with lexical editor.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-left">
            <h2 className="mb-2 text-xl font-semibold text-white">Subdocs</h2>
            <p className="text-zinc-400">
              Hierarchical document structure with nested navigation and
              real-time sync. Shows how to build tree-based UIs with DocNode.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

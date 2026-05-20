import Link from "next/link";

const examples = [
  {
    title: "Editor",
    href: "/examples/editor",
    description:
      "A Lexical-based rich text editor with formatting, presence, undo, and multi-client sync.",
  },
  {
    title: "Subdocs",
    href: "/examples/subdocs",
    description:
      "A nested document UI that shows sync across primary and secondary DocNode documents.",
  },
];

export default function ExamplesPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-2xl text-center">
        <h1 className="mb-4 text-4xl font-bold text-white">DocNode Examples</h1>
        <p className="mb-8 text-lg text-zinc-400">
          Interactive examples showing DocNode and DocSync in multi-client
          workflows.
        </p>
        <div className="grid gap-4 text-left">
          {examples.map((example) => (
            <Link
              key={example.href}
              href={example.href}
              className="block rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              <h2 className="mb-2 text-xl font-semibold text-white">
                {example.title}
              </h2>
              <p className="text-zinc-400">{example.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

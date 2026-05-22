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
    <main className="mx-auto w-full max-w-4xl px-6 py-12 md:py-16">
      <div className="mb-8 max-w-2xl">
        <h1 className="mb-4 text-4xl font-bold tracking-tight">Examples</h1>
        <p className="text-fd-muted-foreground text-lg">
          Interactive examples showing DocNode and DocSync in multi-client
          workflows.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {examples.map((example) => (
          <Link
            key={example.href}
            href={example.href}
            className="border-fd-border bg-fd-card hover:bg-fd-accent block rounded-lg border p-6 transition-colors"
          >
            <h2 className="mb-2 text-xl font-semibold">{example.title}</h2>
            <p className="text-fd-muted-foreground">{example.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}

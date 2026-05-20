"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type React from "react";

const examples = [
  { name: "Editor", path: "/examples/editor" },
  { name: "Subdocs", path: "/examples/subdocs" },
];

export default function ExamplesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="dark flex min-h-screen bg-zinc-950 text-zinc-100">
      <aside className="w-64 shrink-0 border-r border-zinc-800 bg-zinc-900/50 p-6">
        <Link href="/examples" className="mb-6 block text-lg font-semibold">
          DocNode Examples
        </Link>
        <nav className="space-y-1">
          {examples.map((example) => {
            const isActive = pathname === example.path;
            return (
              <Link
                key={example.path}
                href={example.path}
                className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-zinc-800 font-medium text-white"
                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                }`}
              >
                {example.name}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

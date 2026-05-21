"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const examples = [
  { name: "Editor", path: "/examples/editor" },
  { name: "Subdocs", path: "/examples/subdocs" },
];

export function ExamplesSidebar() {
  const pathname = usePathname();

  return (
    <aside className="border-fd-border bg-fd-background/80 shrink-0 border-b p-4 md:w-64 md:border-r md:border-b-0 md:p-6">
      <Link
        href="/examples"
        className="text-fd-foreground mb-4 block text-lg font-semibold md:mb-6"
      >
        Examples
      </Link>
      <nav className="flex gap-1 md:block md:space-y-1">
        {examples.map((example) => {
          const isActive = pathname === example.path;
          return (
            <Link
              key={example.path}
              href={example.path}
              className={cn(
                "block rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-fd-accent text-fd-accent-foreground font-medium"
                  : "text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground",
              )}
            >
              {example.name}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

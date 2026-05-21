"use client";

import type React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { createDocId } from "@/components/examples/utils/docId";

const examples = [
  { name: "Editor", path: "/examples/editor", usesDocId: true },
  { name: "Subdocs", path: "/examples/subdocs", usesDocId: true },
];

export function ExamplesSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  function openExample(
    event: React.MouseEvent<HTMLAnchorElement>,
    example: (typeof examples)[number],
  ) {
    if (!example.usesDocId) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    router.push(`${example.path}?docId=${createDocId()}`);
  }

  return (
    <aside className="border-fd-border bg-fd-background/80 shrink-0 border-b p-3 md:w-48 md:border-r md:border-b-0 md:p-4">
      <Link
        href="/examples"
        className="text-fd-foreground mb-3 block text-base font-semibold md:mb-4"
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
              onClick={(event) => openExample(event, example)}
              className={cn(
                "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
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

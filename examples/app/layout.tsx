"use client";

import "./globals.css";
import { usePathname } from "next/navigation";
import Link from "next/link";

const examples = [
  { name: "Editor", path: "/editor" },
  { name: "Subdocs", path: "/subdocs" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body style={{ colorScheme: "dark" }}>
        <div className="flex min-h-screen bg-zinc-950">
          {/* Sidebar */}
          <aside className="w-64 border-r border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="mb-6 text-lg font-semibold text-white">
              DocNode Examples
            </h2>
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

          {/* Main content */}
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}

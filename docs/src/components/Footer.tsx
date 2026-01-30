import React from "react";
import Link from "next/link";

const Footer = () => {
  return (
    <footer className="relative mt-24 border-t border-slate-800 bg-slate-950/50 backdrop-blur-sm">
      <div className="container mx-auto px-6 py-16 md:py-24">
        <div className="mx-auto flex max-w-3xl flex-col justify-center gap-12 md:flex-row md:gap-20">
          {/* Libraries */}
          <div>
            <h3 className="mb-4 text-sm font-bold tracking-wider text-white uppercase">
              Libraries
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="/docnode"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  DocNode
                </Link>
              </li>
              <li>
                <Link
                  href="/docsync"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  DocSync
                </Link>
              </li>
            </ul>
          </div>

          {/* Compare */}
          <div>
            <h3 className="mb-4 text-sm font-bold tracking-wider text-white uppercase">
              Compare
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="/docnode#comparison-table"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  DocNode vs Yjs
                </Link>
              </li>
              <li>
                <Link
                  href="/docsync#comparison-table"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  DocSync vs Hocuspocus
                </Link>
              </li>
            </ul>
          </div>

          {/* Community */}
          <div>
            <h3 className="mb-4 text-sm font-bold tracking-wider text-white uppercase">
              Community
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="/blog"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  Blog
                </Link>
              </li>
              <li>
                <a
                  href="https://x.com/docnode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  Twitter
                </a>
              </li>
              <li>
                <a
                  href="https://discord.gg/WWCWcphGSJ"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  Discord
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/docnode/docnode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 transition-colors hover:text-white"
                >
                  GitHub
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;

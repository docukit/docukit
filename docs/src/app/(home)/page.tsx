import React from "react";
import Link from "next/link";
import type { Metadata } from "next";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";
import DocEditorLogo from "@/icons/DocEditorLogo";
import DocGridLogo from "@/icons/DocGridLogo";

export const metadata: Metadata = {
  title: "DocuKit - Build local-first apps easily",
  description: "Real-time collaborative tools for modern developers.",
};

const AnimatedBackground = () => (
  <div className="fixed inset-0 -z-10 overflow-hidden bg-[#020617]">
    {/* Abstract moving blobs */}
    <div className="absolute -top-[10%] -left-[10%] h-[60%] w-[60%] animate-pulse rounded-full bg-emerald-500/10 blur-[120px]" />
    <div
      className="absolute -right-[10%] -bottom-[10%] h-[60%] w-[60%] animate-pulse rounded-full bg-blue-500/10 blur-[120px]"
      style={{ animationDelay: "2s" }}
    />
    <div className="animate-float absolute top-[20%] left-[20%] h-[40%] w-[40%] rounded-full bg-indigo-500/5 blur-[100px]" />
    <div className="animate-float-delayed absolute top-[30%] right-[10%] h-[35%] w-[35%] rounded-full bg-cyan-500/5 blur-[100px]" />

    <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(2,6,23,0.8)_100%)]" />
  </div>
);

const Index = () => {
  const products = [
    {
      title: "DocNode",
      description: "Conflict resolution documents. Faster than any CRDT.",
      details:
        "Alternative to Yjs, Loro, and Automerge. Built for speed and flexibility.",
      icon: <DocNodeLogo className="h-12 w-auto" />,
      href: "/docs/docnode",
      color: "green",
    },
    {
      title: "DocSync",
      description: "Agnostic local-first sync engine.",
      details:
        "Works with Yjs, Loro, and DocNode. The agnostic alternative to Hocuspocus.",
      icon: <DocSyncLogo className="h-12 w-auto" />,
      href: "/docs/docsync",
      color: "blue",
    },
    {
      title: "DocEditor",
      description: "Ready-to-use RTE based on DocNode.",
      details:
        "A high-level rich text editor. Modern alternative to Lexical and TipTap.",
      icon: <DocEditorLogo className="h-12 w-auto" />,
      href: "/docs/doceditor",
      color: "blue",
    },
    {
      title: "DocGrid",
      description: "High-performance data grid for local-first.",
      details:
        "Efficient table management. Alternative to AG Grid and Tanstack Tables.",
      icon: <DocGridLogo className="h-12 w-auto" />,
      href: "/docs/docgrid",
      color: "green",
    },
  ];

  return (
    <div className="relative min-h-screen text-slate-200 selection:bg-emerald-500/30">
      <AnimatedBackground />

      <main className="container mx-auto px-6 pt-24 pb-24 md:pt-32">
        <header className="mb-16 text-center">
          <h1 className="text-6xl font-black tracking-tight sm:text-7xl md:text-9xl">
            Build
            <span className="bg-gradient-to-b from-white to-slate-500 bg-clip-text text-transparent">
              {" "}
              local-first{" "}
            </span>
            apps easily.
          </h1>
        </header>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:gap-12">
          {products.map((product, i) => (
            <ProductCard key={product.title} {...product} delay={i * 0.15} />
          ))}
        </div>
      </main>
    </div>
  );
};

interface ProductCardProps {
  title: string;
  description: string;
  details: string;
  icon: React.ReactNode;
  href: string;
  color: "green" | "blue";
  delay: number;
}

const ProductCard: React.FC<ProductCardProps> = ({
  title,
  description,
  details,
  icon,
  href,
  color,
  delay,
}) => {
  const isGreen = color === "green";

  return (
    <Link
      href={href}
      className={`animate-fade-in-up group relative flex flex-col overflow-hidden rounded-[3rem] border-t border-white/20 p-8 transition-all duration-500 hover:-translate-y-3 hover:shadow-[0_20px_50px_rgba(0,0,0,0.3)] ${
        isGreen
          ? "bg-emerald-600 shadow-emerald-900/20 hover:bg-emerald-500"
          : "bg-blue-600 shadow-blue-900/20 hover:bg-blue-500"
      } `}
      style={{
        animationDelay: `${delay}s`,
      }}
    >
      {/* Decorative background shapes */}
      <div
        className={`absolute -top-6 -right-6 h-40 w-40 rounded-full opacity-20 blur-2xl transition-all duration-700 group-hover:scale-150 group-hover:opacity-40 ${isGreen ? "bg-emerald-200" : "bg-blue-200"}`}
      />
      <div
        className={`absolute -bottom-10 -left-10 h-48 w-48 rounded-full opacity-10 blur-xl transition-all duration-700 group-hover:scale-125 ${isGreen ? "bg-white" : "bg-white"}`}
      />

      <div className="relative z-10">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-white p-4 shadow-2xl transition-all duration-500 group-hover:scale-110 group-hover:rotate-12">
          {icon}
        </div>

        <h2 className="mb-3 text-4xl font-black text-white md:text-5xl">
          {title}
        </h2>

        <p className="mb-4 text-xl leading-tight font-bold text-white/95">
          {description}
        </p>

        <p className="max-w-[90%] text-lg font-medium text-white/80">
          {details}
        </p>

        <div className="mt-8 flex items-center gap-3 font-black text-white">
          <span className="text-sm tracking-[0.2em] uppercase">
            Read Documentation
          </span>
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm transition-all duration-300 group-hover:translate-x-3 group-hover:bg-white/40">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
          </div>
        </div>
      </div>
    </Link>
  );
};

export default Index;

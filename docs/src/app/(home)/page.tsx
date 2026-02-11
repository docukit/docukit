import React from "react";
import Link from "next/link";
import type { Metadata } from "next";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";
import { SyncedEditorsDemo } from "@/components/SyncedEditorsDemo";
// import DocEditorLogo from "@/icons/DocEditorLogo";
// import DocGridLogo from "@/icons/DocGridLogo";

export const metadata: Metadata = {
  title: "Build local-first apps easily",
  description: "Real-time collaborative tools for modern developers.",
  icons: {
    icon: "/favicon.svg",
  },
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
      headline:
        "Type-safe documents with conflict resolution. Faster than any CRDT.",
      icon: <DocNodeLogo className="h-10 w-auto" />,
      href: "/docnode",
      color: "green",
    },
    {
      title: "DocSync",
      headline:
        "Agnostic local-first sync engine. Works with DocNode, Yjs, or Loro.",
      icon: <DocSyncLogo className="h-10 w-auto" />,
      href: "/docsync",
      color: "blue",
      badge: "alpha",
    },
    // {
    //   title: "DocEditor",
    //   headline: "The ready-to-use RTE alternative to Lexical and TipTap.",
    //   icon: <DocEditorLogo className="h-10 w-auto" />,
    //   href: "/doceditor",
    //   color: "blue",
    // },
    // {
    //   title: "DocGrid",
    //   headline:
    //     "High-performance data grid alternative to AG Grid and Tanstack.",
    //   icon: <DocGridLogo className="h-10 w-auto" />,
    //   href: "/docgrid",
    //   color: "green",
    // },
  ] as const;

  return (
    <div className="relative min-h-screen text-slate-200 selection:bg-emerald-500/30">
      <AnimatedBackground />

      <main className="container mx-auto px-6 pt-16 pb-16 md:pt-24">
        <header className="mb-16 text-center">
          {/* Badge */}
          {/* <div className="mb-6 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
              </span>
              Real-time collaboration made simple
            </div>
          </div> */}

          {/* Heading */}
          <h1 className="text-4xl font-black tracking-tight sm:text-5xl md:text-7xl">
            Build
            <span className="bg-linear-to-r from-blue-400 to-emerald-500 bg-clip-text text-transparent">
              {" "}
              local-first{" "}
            </span>
            apps, faster.
          </h1>

          {/* Subheading */}
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400 sm:text-xl">
            Type-safe documents, conflict-free sync, and real-time
            collaboration. Building modern local-first applications has never
            been easier.
          </p>
        </header>

        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 md:grid-cols-2 lg:gap-10">
          {products.map((product, i) => (
            <ProductCard key={product.title} {...product} delay={i * 0.1} />
          ))}
        </div>

        <div className="mx-auto mt-28 max-w-6xl md:mt-36">
          <SyncedEditorsDemo />
        </div>
      </main>
    </div>
  );
};

interface ProductCardProps {
  title: string;
  headline: string;
  icon: React.ReactNode;
  href: string;
  color: "green" | "blue";
  delay: number;
  badge?: string;
}

const ProductCard: React.FC<ProductCardProps> = ({
  title,
  headline,
  icon,
  href,
  color,
  delay,
  badge,
}) => {
  const isGreen = color === "green";

  return (
    <Link
      href={href}
      className={`animate-fade-in-up group relative isolate flex transform-[translateZ(0)] flex-col overflow-hidden rounded-[2.5rem] p-6 transition-all duration-500 backface-hidden hover:-translate-y-2 hover:shadow-[0_20px_50px_rgba(0,0,0,0.3)] ${
        isGreen
          ? "bg-emerald-600 shadow-emerald-900/20 hover:bg-emerald-500"
          : "bg-blue-600 shadow-blue-900/20 hover:bg-blue-500"
      } `}
      style={{
        animationDelay: `${delay}s`,
      }}
    >
      {/* Top highlight border */}
      <div className="absolute inset-x-0 top-0 z-20 h-px bg-white/20" />

      {/* Badge (e.g. alpha) - top right */}
      {badge && (
        <div className="absolute top-6 right-6 z-20 rounded-md bg-white px-3 py-1.5 text-xs font-bold tracking-wider text-blue-600 uppercase">
          {badge}
        </div>
      )}

      {/* Decorative background shapes */}
      <div
        className={`absolute -top-6 -right-6 h-32 w-32 rounded-full opacity-20 blur-2xl transition-all duration-700 group-hover:scale-150 group-hover:opacity-40 ${isGreen ? "bg-emerald-400" : "bg-blue-400"}`}
      />
      <div
        className={`absolute -bottom-10 -left-10 h-32 w-32 rounded-full opacity-10 blur-xl transition-all duration-700 group-hover:scale-125 ${isGreen ? "bg-white" : "bg-white"}`}
      />

      <div className="relative z-10">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-white p-3 shadow-2xl transition-all duration-500 group-hover:scale-110 group-hover:rotate-12">
          {icon}
        </div>

        <h2 className="mb-1 text-3xl font-black text-white md:text-4xl">
          {title}
        </h2>

        <p className="mb-6 max-w-[90%] text-lg leading-tight font-bold text-white/95">
          {headline}
        </p>

        <div className="mt-auto flex items-center gap-2 font-black text-white">
          <span className="text-xs tracking-[0.2em] uppercase">
            Read the docs
          </span>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm transition-all duration-300 group-hover:translate-x-2 group-hover:bg-white/40">
            <svg
              className="h-5 w-5"
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

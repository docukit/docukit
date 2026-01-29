import React from "react";
import Link from "next/link";
import type { Metadata } from "next";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";

export const metadata: Metadata = {
  title: "DocNode - Build local-first apps easily",
  description:
    "Real-time collaborative documents with automatic conflict resolution",
  openGraph: {
    title: "DocNode - Build local-first apps easily",
    description:
      "Real-time collaborative documents with automatic conflict resolution",
    images: ["/og-logo.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "DocNode - Build local-first apps easily",
    description:
      "Real-time collaborative documents with automatic conflict resolution",
    images: ["/og-logo.png"],
  },
};

const Index = () => {
  const coreFeatures = [
    "CRDT and OT modes",
    "Move operation",
    "Enforce complex structures",
    "Type-safe node schemas",
    "Nodes with exposed ID",
    "Undo manager",
  ];

  const syncFeatures = [
    "Auth and Access control",
    "History version",
    "Encryption",
    "Autoscaling and sharding",
    "Self-hosted",
    "Real-time multi-tab and multi-device sync",
  ];

  return (
    <div className="bg-background gradient-mesh min-h-screen">
      <section className="px-6 pt-28 pb-20 md:pt-36">
        <div className="container mx-auto text-center">
          {/* Badge */}
          <div className="animate-fade-in mb-6 inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-4 py-1.5 text-sm font-medium text-blue-400 backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500"></span>
            </span>
            Open Source & Self-Hosted
          </div>

          <h1 className="text-foreground animate-fade-in mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-7xl">
            Build
            <span className="bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
              {" "}
              local-first{" "}
            </span>
            apps easily
          </h1>

          <p className="mx-auto mb-12 max-w-2xl text-lg text-slate-400 md:text-xl">
            Real-time collaborative documents with automatic conflict
            resolution.
            <span className="mt-1 block text-slate-500">
              Built for developers who care about user experience.
            </span>
          </p>

          <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-2 lg:gap-8">
            <div className="animate-fade-in" style={{ animationDelay: "0.2s" }}>
              <FeatureCard
                title="DocNode"
                description="Faster than any CRDT. The Yjs alternative."
                features={coreFeatures}
                icon={<DocNodeLogo className="h-10 w-auto" />}
                href="/docs/docnode"
                accentColor="green"
              />
            </div>
            <div className="animate-fade-in" style={{ animationDelay: "0.4s" }}>
              <FeatureCard
                title="DocSync"
                description="CRDT-agnostic local-first sync engine"
                features={syncFeatures}
                icon={<DocSyncLogo className="h-10 w-auto" />}
                href="/docs/docsync"
                accentColor="blue"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Index;

interface FeatureCardProps {
  title: string;
  description: string;
  features: string[];
  icon?: React.ReactNode;
  href: string;
  accentColor: "green" | "blue";
}

const FeatureCard: React.FC<FeatureCardProps> = ({
  title,
  description,
  features,
  icon,
  href,
  accentColor,
}) => {
  const accentClasses = {
    green: {
      border: "hover:border-emerald-500/50",
      glow: "hover:shadow-emerald-500/10",
      icon: "group-hover:text-emerald-400",
      bullet: "bg-emerald-500",
      link: "text-emerald-400 hover:text-emerald-300",
      linkBg: "hover:bg-emerald-500/10",
    },
    blue: {
      border: "hover:border-blue-500/50",
      glow: "hover:shadow-blue-500/10",
      icon: "group-hover:text-blue-400",
      bullet: "bg-blue-500",
      link: "text-blue-400 hover:text-blue-300",
      linkBg: "hover:bg-blue-500/10",
    },
  };

  const accent = accentClasses[accentColor];

  return (
    <Link
      href={href}
      className={`group relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${accent.border} ${accent.glow}`}
    >
      {/* Gradient overlay on hover */}
      <div
        className={`absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 ${
          accentColor === "green"
            ? "bg-gradient-to-br from-emerald-500/5 via-transparent to-transparent"
            : "bg-gradient-to-br from-blue-500/5 via-transparent to-transparent"
        }`}
      />

      <div className="relative z-10">
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <div className={`transition-colors duration-300 ${accent.icon}`}>
            {icon}
          </div>
          <div className="text-left">
            <h2 className="text-xl font-semibold text-white">{title}</h2>
            <p className="text-sm text-slate-400">{description}</p>
          </div>
        </div>

        {/* Divider */}
        <div className="mb-4 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Features */}
        <ul className="mb-6 grid grid-cols-1 gap-2.5 text-left">
          {features.map((feature, index) => (
            <li key={index} className="flex items-start gap-3">
              <span
                className={`mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full ${accent.bullet}`}
              />
              <span className="text-sm leading-relaxed text-slate-300">
                {feature}
              </span>
            </li>
          ))}
        </ul>

        {/* Link */}
        <div className="mt-auto pt-2">
          <span
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${accent.link} ${accent.linkBg}`}
          >
            Explore {title}
            <svg
              className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
          </span>
        </div>
      </div>
    </Link>
  );
};

import React from "react";
import Link from "next/link";
import type { Metadata } from "next";

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
      <section className="px-6 pt-32 pb-20">
        <div className="container mx-auto text-center">
          <h1 className="text-foreground animate-fade-in mb-4 text-5xl font-bold md:text-7xl">
            Build
            <span className="bg-linear-to-r from-green-600 to-green-400 bg-clip-text text-transparent">
              {" "}
              local-first{" "}
            </span>
            apps easily
          </h1>

          <p className="mb-8 text-lg text-slate-300 md:text-xl">
            Real-time collaborative documents with automatic conflict resolution
          </p>

          <Link
            href="/docs"
            className="bg-background bg-opacity-50 mb-6 inline-block rounded-full border border-emerald-500 px-4 py-1 text-xl font-medium backdrop-blur-sm transition-all duration-300 hover:border-green-400/50 hover:bg-green-400/10 hover:shadow-[0_0_20px_rgba(74,222,128,0.3)] hover:shadow-green-400/30"
          >
            Read the docs →
          </Link>

          <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-2">
            <div className="animate-fade-in" style={{ animationDelay: "0.2s" }}>
              <FeatureCard title="DocNode" features={coreFeatures} />
            </div>
            <div className="animate-fade-in" style={{ animationDelay: "0.4s" }}>
              <FeatureCard title="DocSync" features={syncFeatures} />
            </div>
          </div>
        </div>
      </section>

      {/* Footer - TODO. Ideas: All rights reserved, privacy policy, terms of service, etc. */}
    </div>
  );
};

export default Index;

interface FeatureCardProps {
  title: string;
  features: string[];
}

const FeatureCard: React.FC<FeatureCardProps> = ({ title, features }) => {
  return (
    <div className="bg-background hover:shadow-primary/20 rounded-lg p-4 opacity-80 backdrop-blur-3xl transition-all duration-300 hover:-translate-y-1 hover:shadow-lg">
      <h2 className="pb-6 text-3xl font-semibold text-green-400">{title}</h2>
      <ul className="space-y-3">
        {features.map((feature, index) => (
          <li
            key={index}
            className="before:text-primary before:mt-1 before:mr-2 before:text-xl before:content-['-']"
          >
            <span className="text-sm leading-relaxed">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

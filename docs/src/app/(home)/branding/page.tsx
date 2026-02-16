import React from "react";
import DocuKitLogo, { DocuKitLogoCircular } from "@/icons/DocuKitLogo";
import DocuKitFavicon, { DocuKitFaviconCircular } from "@/icons/DocuKitFavicon";
import { GREEN, BLUE } from "@/lib/brand-colors";

export const metadata = {
  title: "Branding | DocuKit",
  description: "DocuKit responsive logo design system",
  icons: { icon: "/favicon.svg" },
};

function LogoSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-16">
      <h2 className="mb-2 text-2xl font-bold">{title}</h2>
      <p className="text-muted-foreground mb-6">{description}</p>
      <div className="flex flex-wrap items-center gap-8">{children}</div>
    </section>
  );
}

function LogoCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center justify-center rounded-xl bg-gray-100 p-8 dark:bg-gray-800">
        {children}
      </div>
      <span className="text-muted-foreground text-sm">{label}</span>
    </div>
  );
}

export default function BrandingPage() {
  return (
    <main className="container mx-auto max-w-6xl px-6 py-12">
      <header className="mb-12">
        <h1 className="mb-4 text-4xl font-bold">
          Responsive Logo Design System
        </h1>
        <p className="text-muted-foreground text-lg">
          Complete logo system for DocuKit with square and circular variants for
          different contexts.
        </p>
      </header>

      {/* Color palette */}
      <section className="mb-16">
        <h2 className="mb-4 text-2xl font-bold">Color Palette</h2>
        <div className="flex gap-4">
          <div className="flex flex-col items-center">
            <div
              className="h-20 w-20 rounded-lg"
              style={{ backgroundColor: GREEN }}
            />
            <span className="mt-2 font-mono text-sm">{GREEN}</span>
            <span className="text-muted-foreground text-xs">Green</span>
          </div>
          <div className="flex flex-col items-center">
            <div
              className="h-20 w-20 rounded-lg"
              style={{ backgroundColor: BLUE }}
            />
            <span className="mt-2 font-mono text-sm">{BLUE}</span>
            <span className="text-muted-foreground text-xs">Blue</span>
          </div>
        </div>
      </section>

      {/* Full Logo */}
      <LogoSection
        title="Full Logo"
        description="Primary logo with 4 product icons. Use when there's plenty of space."
      >
        <LogoCard label="Square">
          <div className="h-48 w-48">
            <DocuKitLogo className="h-full w-full" />
          </div>
        </LogoCard>
        <LogoCard label="Circular">
          <div className="h-48 w-48">
            <DocuKitLogoCircular className="h-full w-full" />
          </div>
        </LogoCard>
      </LogoSection>

      {/* Favicon */}
      <LogoSection
        title="Favicon"
        description="Minimal 4-color squares for favicon and very small contexts."
      >
        <LogoCard label="Square">
          <div className="h-48 w-48">
            <DocuKitFavicon className="h-full w-full" />
          </div>
        </LogoCard>
        <LogoCard label="Circular">
          <div className="h-48 w-48">
            <DocuKitFaviconCircular className="h-full w-full" />
          </div>
        </LogoCard>
      </LogoSection>

      {/* Usage Guidelines */}
      <section className="mb-16">
        <h2 className="mb-4 text-2xl font-bold">Usage Guidelines</h2>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border p-6">
            <h3 className="mb-2 font-semibold">Full Logo</h3>
            <p className="text-muted-foreground text-sm">
              Use for headers, landing pages, and marketing materials where
              space allows. Minimum recommended size: 64px.
            </p>
          </div>
          <div className="rounded-lg border p-6">
            <h3 className="mb-2 font-semibold">Favicon</h3>
            <p className="text-muted-foreground text-sm">
              Use for browser tabs, bookmarks, and app icons. Works well at very
              small sizes: 16px - 64px.
            </p>
          </div>
        </div>
      </section>

      {/* Size Reference Table */}
      <section className="mb-16">
        <h2 className="mb-4 text-2xl font-bold">Size Reference</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-3 text-left">Size</th>
                <th className="px-4 py-3 text-left">Full Logo</th>
                <th className="px-4 py-3 text-left">Favicon</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">16px</td>
                <td className="px-4 py-4">
                  <div className="h-4 w-4">
                    <DocuKitLogo className="h-full w-full" />
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="h-4 w-4">
                    <DocuKitFavicon className="h-full w-full" />
                  </div>
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">32px</td>
                <td className="px-4 py-4">
                  <div className="h-8 w-8">
                    <DocuKitLogo className="h-full w-full" />
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="h-8 w-8">
                    <DocuKitFavicon className="h-full w-full" />
                  </div>
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">48px</td>
                <td className="px-4 py-4">
                  <div className="h-12 w-12">
                    <DocuKitLogo className="h-full w-full" />
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="h-12 w-12">
                    <DocuKitFavicon className="h-full w-full" />
                  </div>
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">64px</td>
                <td className="px-4 py-4">
                  <div className="h-16 w-16">
                    <DocuKitLogo className="h-full w-full" />
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="h-16 w-16">
                    <DocuKitFavicon className="h-full w-full" />
                  </div>
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">100px</td>
                <td className="px-4 py-4">
                  <div className="h-25 w-25">
                    <DocuKitLogo className="h-full w-full" />
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="h-25 w-25">
                    <DocuKitFavicon className="h-full w-full" />
                  </div>
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">200px</td>
                <td className="px-4 py-4">
                  <div className="h-50 w-50">
                    <DocuKitLogo className="h-full w-full" />
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="h-50 w-50">
                    <DocuKitFavicon className="h-full w-full" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

import React from "react";
import DocuKitLogo, { DocuKitLogoCircular } from "@/icons/DocuKitLogo";
import DocuKitLogoSmall, {
  DocuKitLogoSmallCircular,
} from "@/icons/DocuKitLogoSmall";
import DocuKitFavicon, { DocuKitFaviconCircular } from "@/icons/DocuKitFavicon";

export const metadata = {
  title: "Branding | DocuKit",
  description: "DocuKit responsive logo design system",
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
  bgDark = false,
}: {
  label: string;
  children: React.ReactNode;
  bgDark?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={`flex items-center justify-center rounded-lg p-8 ${
          bgDark ? "bg-gray-900" : "bg-gray-100 dark:bg-gray-800"
        }`}
      >
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
              style={{ backgroundColor: "#00C853" }}
            />
            <span className="mt-2 font-mono text-sm">#00C853</span>
            <span className="text-muted-foreground text-xs">Green</span>
          </div>
          <div className="flex flex-col items-center">
            <div
              className="h-20 w-20 rounded-lg"
              style={{ backgroundColor: "#1b68f5" }}
            />
            <span className="mt-2 font-mono text-sm">#1b68f5</span>
            <span className="text-muted-foreground text-xs">Blue</span>
          </div>
        </div>
      </section>

      {/* Full Logo */}
      <LogoSection
        title="Full Logo"
        description="Primary logo with 4 product icons. Use when there's plenty of space."
      >
        <LogoCard label="Square (200px)">
          <DocuKitLogo size={200} />
        </LogoCard>
        <LogoCard label="Square (150px)">
          <DocuKitLogo size={150} />
        </LogoCard>
        <LogoCard label="Circular (200px)">
          <DocuKitLogoCircular size={200} />
        </LogoCard>
        <LogoCard label="Circular (150px)">
          <DocuKitLogoCircular size={150} />
        </LogoCard>
      </LogoSection>

      {/* Full Logo on Dark */}
      <LogoSection
        title="Full Logo (Dark Background)"
        description="Same logos on dark background for contrast testing."
      >
        <LogoCard label="Square (200px)" bgDark>
          <DocuKitLogo size={200} />
        </LogoCard>
        <LogoCard label="Circular (200px)" bgDark>
          <DocuKitLogoCircular size={200} />
        </LogoCard>
      </LogoSection>

      {/* Simplified Logo */}
      <LogoSection
        title="Simplified Logo"
        description="Simplified version with thinner lines and no node circles. Use for smaller spaces."
      >
        <LogoCard label="Square (100px)">
          <DocuKitLogoSmall size={100} />
        </LogoCard>
        <LogoCard label="Square (64px)">
          <DocuKitLogoSmall size={64} />
        </LogoCard>
        <LogoCard label="Square (48px)">
          <DocuKitLogoSmall size={48} />
        </LogoCard>
        <LogoCard label="Circular (100px)">
          <DocuKitLogoSmallCircular size={100} />
        </LogoCard>
        <LogoCard label="Circular (64px)">
          <DocuKitLogoSmallCircular size={64} />
        </LogoCard>
        <LogoCard label="Circular (48px)">
          <DocuKitLogoSmallCircular size={48} />
        </LogoCard>
      </LogoSection>

      {/* Simplified Logo on Dark */}
      <LogoSection
        title="Simplified Logo (Dark Background)"
        description="Simplified logos on dark background."
      >
        <LogoCard label="Square (100px)" bgDark>
          <DocuKitLogoSmall size={100} />
        </LogoCard>
        <LogoCard label="Circular (100px)" bgDark>
          <DocuKitLogoSmallCircular size={100} />
        </LogoCard>
      </LogoSection>

      {/* Favicon */}
      <LogoSection
        title="Favicon"
        description="Minimal 4-color squares for favicon and very small contexts."
      >
        <LogoCard label="Square (64px)">
          <DocuKitFavicon size={64} />
        </LogoCard>
        <LogoCard label="Square (32px)">
          <DocuKitFavicon size={32} />
        </LogoCard>
        <LogoCard label="Square (16px)">
          <DocuKitFavicon size={16} />
        </LogoCard>
        <LogoCard label="Circular (64px)">
          <DocuKitFaviconCircular size={64} />
        </LogoCard>
        <LogoCard label="Circular (32px)">
          <DocuKitFaviconCircular size={32} />
        </LogoCard>
        <LogoCard label="Circular (16px)">
          <DocuKitFaviconCircular size={16} />
        </LogoCard>
      </LogoSection>

      {/* Favicon on Dark */}
      <LogoSection
        title="Favicon (Dark Background)"
        description="Favicons on dark background."
      >
        <LogoCard label="Square (64px)" bgDark>
          <DocuKitFavicon size={64} />
        </LogoCard>
        <LogoCard label="Square (32px)" bgDark>
          <DocuKitFavicon size={32} />
        </LogoCard>
        <LogoCard label="Circular (64px)" bgDark>
          <DocuKitFaviconCircular size={64} />
        </LogoCard>
        <LogoCard label="Circular (32px)" bgDark>
          <DocuKitFaviconCircular size={32} />
        </LogoCard>
      </LogoSection>

      {/* Usage Guidelines */}
      <section className="mb-16">
        <h2 className="mb-4 text-2xl font-bold">Usage Guidelines</h2>
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-lg border p-6">
            <h3 className="mb-2 font-semibold">Full Logo</h3>
            <p className="text-muted-foreground text-sm">
              Use for headers, landing pages, and marketing materials where
              space allows. Minimum recommended size: 100px.
            </p>
          </div>
          <div className="rounded-lg border p-6">
            <h3 className="mb-2 font-semibold">Simplified Logo</h3>
            <p className="text-muted-foreground text-sm">
              Use for navigation, toolbars, and medium-sized contexts.
              Recommended size range: 32px - 100px.
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

      {/* All Sizes Reference */}
      <section className="mb-16">
        <h2 className="mb-4 text-2xl font-bold">Size Reference</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-3 text-left">Size</th>
                <th className="px-4 py-3 text-left">Full Logo</th>
                <th className="px-4 py-3 text-left">Simplified</th>
                <th className="px-4 py-3 text-left">Favicon</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">16px</td>
                <td className="text-muted-foreground px-4 py-4">
                  Not recommended
                </td>
                <td className="text-muted-foreground px-4 py-4">
                  Not recommended
                </td>
                <td className="px-4 py-4">
                  <DocuKitFavicon size={16} />
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">32px</td>
                <td className="text-muted-foreground px-4 py-4">
                  Not recommended
                </td>
                <td className="px-4 py-4">
                  <DocuKitLogoSmall size={32} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitFavicon size={32} />
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">48px</td>
                <td className="text-muted-foreground px-4 py-4">
                  Not recommended
                </td>
                <td className="px-4 py-4">
                  <DocuKitLogoSmall size={48} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitFavicon size={48} />
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">64px</td>
                <td className="px-4 py-4">
                  <DocuKitLogo size={64} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitLogoSmall size={64} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitFavicon size={64} />
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">100px</td>
                <td className="px-4 py-4">
                  <DocuKitLogo size={100} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitLogoSmall size={100} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitFavicon size={100} />
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-4 font-mono">200px</td>
                <td className="px-4 py-4">
                  <DocuKitLogo size={200} />
                </td>
                <td className="px-4 py-4">
                  <DocuKitLogoSmall size={200} />
                </td>
                <td className="text-muted-foreground px-4 py-4">
                  Not recommended
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

import { DiscordIcon } from "@/icons/DiscordIcon";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Logo2 from "@/icons/DocNodeLogo";
import { Montserrat } from "next/font/google";
import { BrandXIcon } from "@/icons/BrandXIcon";

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export const baseOptions: BaseLayoutProps = {
  themeSwitch: {
    mode: "light-dark",
  },
  githubUrl: "https://github.com/docnode/docnode",
  links: [
    // {
    //   type: "main",
    //   text: "Documentation",
    //   url: "/docs",
    // },
    // {
    //   type: "main",
    //   text: "Blog",
    //   url: "/blog",
    // },
    {
      type: "icon",
      icon: <BrandXIcon />,
      text: "X",
      url: "https://x.com/docnode",
    },
    {
      type: "icon",
      icon: <DiscordIcon />,
      text: "Discord",
      url: "https://discord.gg/WWCWcphGSJ",
    },
  ],
  nav: {
    title: (
      <div className="mr-auto flex items-center justify-center gap-2 text-xl">
        <Logo2 />
        <Logo />
      </div>
    ),
  },
  // see https://fumadocs.dev/docs/ui/navigation/links
};

const montserrat = Montserrat({
  weight: "700",
  subsets: ["latin"],
});

function Logo({ className }: { className?: string }) {
  return (
    <span className={`${montserrat.className} ${className}`}> DocNode </span>
  );
}

import { DiscordIcon } from "@/icons/DiscordIcon";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BrandXIcon } from "@/icons/BrandXIcon";
import DocuKitFavicon from "@/icons/DocuKitFavicon";

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
  githubUrl: "https://github.com/docukit/docukit",
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
      <div className="flex items-center gap-2">
        <DocuKitFavicon className="h-6 w-6" />
        <span className="font-bold">DocuKit</span>
      </div>
    ),
  },
  // see https://fumadocs.dev/docs/ui/navigation/links
};

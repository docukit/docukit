import { DiscordIcon } from "@/icons/DiscordIcon";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";
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
      <div className="mr-auto flex items-center justify-center gap-1.5">
        <DocNodeLogo className="h-6 w-auto" />
        <DocSyncLogo className="h-6 w-auto" />
      </div>
    ),
  },
  // see https://fumadocs.dev/docs/ui/navigation/links
};

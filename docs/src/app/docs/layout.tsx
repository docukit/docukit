import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NavTitle } from "@/components/nav-title";

const options: BaseLayoutProps = {
  ...baseOptions,
  links: [
    ...(baseOptions.links ?? []),
    {
      type: "main",
      text: "Blog",
      url: "/blog",
    },
  ],
};

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <RootProvider theme={{ ...options }}>
      <DocsLayout
        tree={source.pageTree}
        {...options}
        sidebar={{
          title: (<NavTitle />) as unknown as string,
          collapsible: false,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}

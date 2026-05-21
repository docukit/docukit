import { HomeLayout } from "fumadocs-ui/layouts/home";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Footer from "@/components/Footer";
import { baseOptions } from "@/lib/layout.shared";
import { ExamplesSidebar } from "./ExamplesSidebar";

const options: BaseLayoutProps = {
  ...baseOptions,
  links: [
    ...(baseOptions.links ?? []),
    { type: "main", text: "Blog", url: "/blog" },
    { type: "main", text: "Documentation", url: "/docs" },
  ],
};

export default function ExamplesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RootProvider theme={{ ...baseOptions }}>
      <HomeLayout {...options}>
        <div className="bg-fd-background text-fd-foreground">
          <div className="border-fd-border mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-[1800px] flex-col border-t md:flex-row">
            <ExamplesSidebar />
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </div>
        <Footer variant="docs" className="mt-0" />
      </HomeLayout>
    </RootProvider>
  );
}

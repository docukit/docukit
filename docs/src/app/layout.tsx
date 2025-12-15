import "@/app/global.css";
import { Analytics } from "@vercel/analytics/react";
import { Suspense } from "react";
import PostHogPageView from "./PostHogPageView";
import { AISearchTrigger } from "@/components/search";
// import { Banner } from "fumadocs-ui/components/banner";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        {/* <Banner className="bg-emerald-700 text-white">
          <span>
            DocNode is now live! See what the community is saying on{" "}
            <a
              href="https://news.ycombinator.com/item?id=46211551"
              className="underline"
            >
              Hacker News
            </a>{" "}
            🎉
          </span>
        </Banner> */}
        <Suspense fallback={null}>
          <PostHogPageView />
        </Suspense>
        <Analytics />
        <AISearchTrigger />
        {children}
      </body>
    </html>
  );
}

import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createMDX } from "fumadocs-mdx/next";

// Import env here to validate during build
const jiti = createJiti(fileURLToPath(import.meta.url));
await jiti.import("./src/env");

const withMDX = createMDX({
  mdxOptions: {
    rehypeCodeOptions: {
      // Used in other places!
      themes: { light: "light-plus", dark: "dark-plus" },
    },
  },
});

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/local-first",
        destination: "/blog/local-first",
        permanent: true, // 301 redirect
      },
      // Redirect old /docs/ URLs to /docnode
      {
        source: "/docs/:path*",
        destination: "/docnode/:path*",
        permanent: true,
      },
      { source: "/docs", destination: "/docnode", permanent: true },
    ];
  },
  async rewrites() {
    return [
      // Map clean URLs to internal /docs/ structure
      { source: "/docnode/:path*", destination: "/docs/docnode/:path*" },
      { source: "/docnode", destination: "/docs/docnode" },
      { source: "/docsync/:path*", destination: "/docs/docsync/:path*" },
      { source: "/docsync", destination: "/docs/docsync" },
      { source: "/doceditor/:path*", destination: "/docs/doceditor/:path*" },
      { source: "/doceditor", destination: "/docs/doceditor" },
      { source: "/docgrid/:path*", destination: "/docs/docgrid/:path*" },
      { source: "/docgrid", destination: "/docs/docgrid" },
      // LLM mdx files
      { source: "/docs/:path*.mdx", destination: "/llms.mdx/:path*" },
    ];
  },
};

export default withMDX(config);

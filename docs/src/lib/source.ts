import { docs, blogPosts } from "../../.source/server";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { createElement } from "react";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";
import DocEditorLogo from "@/icons/DocEditorLogo";
import DocGridLogo from "@/icons/DocGridLogo";

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: "",
  source: docs.toFumadocsSource(),
  icon(name) {
    if (!name) return;
    if (name === "DocNode") return createElement(DocNodeLogo);
    if (name === "DocSync") return createElement(DocSyncLogo);
    if (name === "DocEditor") return createElement(DocEditorLogo);
    if (name === "DocGrid") return createElement(DocGridLogo);
  },
  plugins: [lucideIconsPlugin()],
});

// Blog loader - blogPosts is an array of docs, convert it with toFumadocsSource
export const blog = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts, []),
});

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, "image.png"];

  return { segments, url: `/og/${segments.join("/")}` };
}

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}

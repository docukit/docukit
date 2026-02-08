import { getPageImage, source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/mdx-components";
import type { Metadata } from "next";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { GitHubIcon } from "@/icons/GithubIcon";
import { ArrowLink } from "@/icons/ArrowLink";
import Footer from "@/components/Footer";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  const toc =
    page.data.toc.length > 0
      ? page.data.toc
      : [
          {
            depth: 1,
            url: "#",
            title: page.data.title,
          },
        ];

  return (
    <DocsPage
      tableOfContent={{
        style: "clerk",
        footer: (
          <>
            <a
              href={`https://github.com/docnode/docnode/blob/main/docs/content/docs/${page.path}`}
              rel="noreferrer noopener"
              target="_blank"
              className="group/option relative flex w-full items-center gap-2 overflow-hidden rounded-md p-2 pt-4 text-xs/4 text-gray-900 transition-colors data-[state=active]:bg-gray-50 dark:text-gray-100 dark:data-[state=active]:bg-gray-900 [button]:hover:bg-gray-50 [button]:dark:hover:bg-gray-900"
            >
              <GitHubIcon className="size-4" />
              <span className="truncate">Edit on GitHub</span>
              <ArrowLink className="size-2 flex-none" />
            </a>
          </>
        ),
      }}
      tableOfContentPopover={{
        header: null,
        enabled: false,
      }}
      toc={toc}
      full={page.data.full}
      footer={{
        children: <Footer variant="docs" />,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<"/docs/[[...slug]]">,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  let icon = "/favicon.svg";
  const slug = params.slug?.[0];
  if (slug === "docnode") icon = "/docnode-icon.svg";
  else if (slug === "docsync") icon = "/docsync-icon.svg";
  else if (slug === "doceditor") icon = "/doceditor-icon.svg";
  else if (slug === "docgrid") icon = "/docgrid-icon.svg";

  return {
    title: `${page.data.title}`,
    description: page.data.description,
    icons: {
      icon,
    },
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}

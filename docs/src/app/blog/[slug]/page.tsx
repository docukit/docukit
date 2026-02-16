import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { blog } from "@/lib/source";
import Article from "@/components/Article";

export default async function BlogPostPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);

  if (!page) notFound();
  const Mdx = page.data.body;

  return (
    <Article
      title={page.data.title}
      author={page.data.author}
      authorLink={"https://x.com/GermanJablo"}
      date={page.data.date}
    >
      <Mdx components={defaultMdxComponents} />
    </Article>
  );
}

export function generateStaticParams(): { slug: string }[] {
  return blog.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);

  if (!page) notFound();

  return { title: page.data.title, description: page.data.description };
}

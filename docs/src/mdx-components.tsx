import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { createGenerator } from "fumadocs-typescript";
import { AutoTypeTable } from "fumadocs-typescript/ui";
import type React from "react";
import { CollapsibleTable } from "./components/CollapsibleTable";

// Create a filtered generator wrapper with correct basePath for monorepo
const baseGenerator = createGenerator({
  basePath: "../",
});
const generator = {
  ...baseGenerator,
  generateTypeTable: async (
    ...args: Parameters<typeof baseGenerator.generateTypeTable>
  ) => {
    const tables = await baseGenerator.generateTypeTable(...args);
    // Filter out properties starting with underscore
    return tables.map((table) => ({
      ...table,
      entries: table.entries.filter((entry) => !entry.name.startsWith("_")),
    }));
  },
};

// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    // I want to make the code block full height.
    // Scrollbars inside scrollbars are an anti-pattern.
    pre: ({ ref: _ref, ...props }) => (
      <CodeBlock {...props} viewportProps={{ className: "max-h-none" }}>
        {/* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access */}
        <Pre>{props.children}</Pre>
      </CodeBlock>
    ),
    AutoTypeTable: (props) => (
      <AutoTypeTable {...props} generator={generator} />
    ),
    CollapsibleTable,
    CodeBlock,
    ...components,
  };
}

"use client";

// Inspired by:
// https://github.com/fuma-nama/fumadocs/blob/4c17abcf866f86f215a261ff637612ee32b8cfca/packages/ui/src/components/type-table.tsx#L60

import { ChevronDown } from "lucide-react";
import { cva } from "class-variance-authority";
import { cn } from "../lib/cn";
import { type ReactNode, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Markdown } from "./markdown";

const keyVariants = cva("text-fd-primary", {
  variants: {
    deprecated: {
      true: "line-through text-fd-primary/50",
    },
  },
});

const fieldVariants = cva("text-fd-muted-foreground not-prose pe-2");

interface RowData {
  name: string;
  type: ReactNode;
  description?: ReactNode | string;
  typeDescription?: ReactNode;
  required?: boolean;
  deprecated?: boolean;
  keyValues?: Array<{ key: string; value: ReactNode }>;
}

interface CollapsibleTableProps {
  rows: Record<string, RowData>;
}

export function CollapsibleTable({ rows }: CollapsibleTableProps) {
  return (
    <div className="bg-fd-card text-fd-card-foreground @container my-6 flex flex-col overflow-hidden rounded-2xl border p-1 text-sm">
      <div className="not-prose text-fd-muted-foreground flex items-center px-3 py-1 font-medium">
        <p className="w-[25%]">Prop</p>
        <p className="@max-xl:hidden">Type</p>
      </div>
      {Object.entries(rows).map(([key, value]) => (
        <Item key={key} name={key} item={value} />
      ))}
    </div>
  );
}

function Item({ name, item }: { name: string; item: RowData }) {
  const {
    description,
    required = false,
    deprecated,
    typeDescription,
    type,
    keyValues = [],
  } = item;

  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "overflow-hidden rounded-xl border transition-all",
        open
          ? "bg-fd-background shadow-sm not-last:mb-2"
          : "border-transparent",
      )}
    >
      <CollapsibleTrigger className="not-prose hover:bg-fd-accent group relative flex w-full flex-row items-center px-3 py-2 text-start">
        <code
          className={cn(
            keyVariants({
              deprecated,
              className: "w-[25%] min-w-fit pe-2 font-medium",
            }),
          )}
        >
          {name}
          {!required && "?"}
        </code>
        <span className="@max-xl:hidden">{type}</span>
        <ChevronDown className="text-fd-muted-foreground absolute end-2 size-4 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="fd-scroll-container grid grid-cols-[1fr_3fr] gap-y-4 overflow-auto border-t p-3 text-sm">
          <div className="prose prose-no-margin col-span-full text-sm empty:hidden">
            {typeof description === "string" ? (
              <Markdown text={description} />
            ) : (
              description
            )}
          </div>
          {typeDescription && (
            <>
              <p className={cn(fieldVariants())}>Type</p>
              <p className="not-prose my-auto">{typeDescription}</p>
            </>
          )}
          {keyValues.map((item, index) => (
            <div key={index} className="contents">
              <p className={cn(fieldVariants())}>{item.key}</p>
              <div className="not-prose my-auto">{item.value}</div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

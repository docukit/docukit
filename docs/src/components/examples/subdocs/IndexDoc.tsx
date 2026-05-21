import { type DocNode, type Doc } from "@docukit/docnode";
import type React from "react";
import { DocRenderer } from "../Renderers";
import { IndexNode } from "../shared-config";

export function IndexDoc({
  doc,
  setActiveDoc,
  selectedDoc,
}: {
  doc: Doc;
  selectedDoc?: string | undefined;
  setActiveDoc?: (docId: string) => void;
}) {
  function handleSelect(ev: React.MouseEvent, docId: string) {
    const target = ev.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    setActiveDoc?.(docId);
  }

  function handleAppend(node: DocNode) {
    if (!doc) return;
    // prettier-ignore
    const lastChild = node.last;
    if (lastChild) {
      const currentLastState = (
        lastChild as DocNode<typeof IndexNode>
      ).state.value.get();
      const newValue = currentLastState.replace(/\d+$/, (match: string) =>
        String(Number(match) + 1).padStart(match.length, "0"),
      );
      const newNode = doc.createNode(IndexNode);
      newNode.state.value.set(newValue);
      node.append(newNode);
    } else if (node.is(IndexNode)) {
      const targetState = node.state.value.get();
      const newNode = doc.createNode(IndexNode);
      newNode.state.value.set(`${targetState}.1`);
      node.append(newNode);
    } else {
      const newNode = doc.createNode(IndexNode);
      newNode.state.value.set("1");
      node.append(newNode);
    }
  }

  function handleDelete(node: DocNode) {
    node.is(IndexNode) ? node.delete() : node.deleteChildren();
  }

  return (
    <div className="docnode-doc text-sm">
      <DocRenderer
        doc={doc}
        render={({ node, children }) => {
          const isSelected = node.id === selectedDoc;
          const isClickable = !!setActiveDoc;

          return (
            <div
              className="relative"
              style={{ paddingLeft: node.is(IndexNode) ? "20px" : "0px" }}
            >
              <div
                onClick={(ev) => handleSelect(ev, node.id)}
                className={`docnode group relative rounded px-2 py-0.5 transition-colors ${
                  isSelected
                    ? "bg-fd-primary/15"
                    : isClickable
                      ? "hover:bg-fd-accent cursor-pointer"
                      : ""
                }`}
                data-node-value={
                  node.is(IndexNode) ? node.state.value.get() : "root"
                }
              >
                {/* Node label */}
                <span className="text-fd-foreground inline-block truncate font-mono text-xs">
                  {node.is(IndexNode) ? node.state.value.get() : "root"}
                  <span className="node-id text-fd-muted-foreground/70 ml-1">
                    {node.id.slice(-4)}
                  </span>
                </span>

                {/* Buttons on hover - floating over the label on the right */}
                <div className="absolute top-0 right-1 hidden flex-row gap-0.5 group-hover:flex">
                  <button
                    className="create bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/80 rounded px-1.5 py-0.5 text-xs font-medium transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAppend(node);
                    }}
                    title="Add child"
                  >
                    +
                  </button>
                  <button
                    className="delete bg-destructive text-fd-primary-foreground hover:bg-destructive/80 rounded px-1.5 py-0.5 text-xs font-medium transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(node);
                    }}
                    title="Delete"
                  >
                    −
                  </button>
                </div>
              </div>
              {children && <div className="mt-0.5">{children}</div>}
            </div>
          );
        }}
      />
    </div>
  );
}

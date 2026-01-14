import { IndexNode } from "./ClientProviders";
import { type DocNode, type Doc } from "docnode";
import { DocRenderer } from "../../components/Renderers";

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
                    ? "bg-emerald-800/50"
                    : isClickable
                      ? "cursor-pointer hover:bg-zinc-800/50"
                      : ""
                }`}
              >
                {/* Node label */}
                <span className="inline-block truncate text-xs text-zinc-300">
                  {node.is(IndexNode) ? node.state.value.get() : "root"}
                  <span className="ml-1 text-zinc-600">
                    {node.id.slice(-6)}
                  </span>
                </span>

                {/* Buttons on hover - floating over the label on the right */}
                <div className="absolute right-1 top-0 hidden flex-row gap-0.5 group-hover:flex">
                  <button
                    className="create rounded bg-green-600/90 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-green-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAppend(node);
                    }}
                    title="Add child"
                  >
                    +
                  </button>
                  <button
                    className="delete rounded bg-red-600/90 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-red-500"
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

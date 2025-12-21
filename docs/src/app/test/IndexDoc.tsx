import { IndexNode, useDoc } from "./ClientLayout";
import { type DocNode } from "docnode";
import { DocRenderer } from "@/components/Renderers";

export function IndexDoc({
  activeDoc,
  setActiveDoc,
  selectedDoc,
}: {
  activeDoc: string;
  selectedDoc?: string;
  setActiveDoc?: (docId: string) => void;
}) {
  const result = useDoc({
    namespace: "indexDoc",
    id: activeDoc,
    createIfMissing: true,
  });
  const doc = result.status === "success" ? result.data : undefined;

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
      const newValue = currentLastState.replace(/\d+$/, (match) =>
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

  // if (isPending) return <div>Loading...</div>;
  // if (isError) return <div>Error</div>;
  if (!doc) return <div>Loading...</div>;
  return (
    <div className="docnode-doc">
      <DocRenderer
        doc={doc}
        render={({ node, children }) => {
          return (
            <div
              className="max-w-xl"
              style={{ paddingLeft: node.is(IndexNode) ? "40px" : "0px" }}
            >
              <div
                onClick={(ev) => handleSelect(ev, node.id)}
                className={`docnode flex items-center ${node.id === selectedDoc ? "bg-emerald-800" : setActiveDoc ? "is-hover:bg-zinc-900 cursor-pointer" : ""}`}
              >
                <span className="inline-block w-44 truncate">
                  {node.is(IndexNode) ? node.state.value.get() : "root"} -{" "}
                  {node.id.slice(-8)}
                </span>
                <button
                  className="create m-1 w-7 rounded bg-green-500 p-1 text-white"
                  onClick={() => handleAppend(node)}
                >
                  +
                </button>
                <button
                  className="delete m-1 min-w-7 rounded bg-red-500 p-1 text-white"
                  onClick={() => handleDelete(node)}
                >
                  -
                </button>
              </div>
              {children && <div>{children}</div>}
            </div>
          );
        }}
      />
    </div>
  );
}

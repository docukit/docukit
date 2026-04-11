import { useEffect, useReducer } from "react";
import * as Y from "yjs";

type DeepObservable = {
  observeDeep(f: () => void): void;
  unobserveDeep(f: () => void): void;
};

function useYjsObserver(yType: DeepObservable) {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const handler = () => forceRender();
    yType.observeDeep(handler);
    // Force re-render to pick up state that may have changed
    // between the initial render and observer registration.
    forceRender();
    return () => yType.unobserveDeep(handler);
  }, [yType]);
}

function YjsNode({
  item,
  selectedDoc,
  setActiveDoc,
  onAppend,
  onDelete,
}: {
  item: Y.Map<unknown>;
  selectedDoc?: string | undefined;
  setActiveDoc?: ((docId: string) => void) | undefined;
  onAppend: (item: Y.Map<unknown>) => void;
  onDelete: (item: Y.Map<unknown>) => void;
}) {
  const id = item.get("id") as string;
  const value = item.get("value") as string;
  const children = item.get("children") as Y.Array<Y.Map<unknown>>;
  const isSelected = id === selectedDoc;
  const isClickable = !!setActiveDoc;

  return (
    <div className="relative" style={{ paddingLeft: "20px" }}>
      <div
        onClick={(ev) => {
          const target = ev.target as HTMLElement;
          if (target.tagName === "BUTTON") return;
          setActiveDoc?.(id);
        }}
        className={`docnode group relative rounded px-2 py-0.5 transition-colors ${
          isSelected
            ? "bg-emerald-800/50"
            : isClickable
              ? "cursor-pointer hover:bg-zinc-800/50"
              : ""
        }`}
        data-node-value={value}
      >
        <span className="inline-block truncate font-mono text-xs text-zinc-300">
          {value}
          <span className="ml-1 text-zinc-600">{id.slice(-4)}</span>
        </span>

        <div className="absolute top-0 right-1 hidden flex-row gap-0.5 group-hover:flex">
          <button
            className="create rounded bg-green-600/90 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-green-500"
            onClick={(e) => {
              e.stopPropagation();
              onAppend(item);
            }}
            title="Add child"
          >
            +
          </button>
          <button
            className="delete rounded bg-red-600/90 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-red-500"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item);
            }}
            title="Delete"
          >
            −
          </button>
        </div>
      </div>

      {children.length > 0 && (
        <div className="mt-0.5">
          {children.toArray().map((child) => (
            <YjsNode
              key={child.get("id") as string}
              item={child}
              selectedDoc={selectedDoc}
              setActiveDoc={setActiveDoc}
              onAppend={onAppend}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function createItem(value: string): Y.Map<unknown> {
  const item = new Y.Map<unknown>();
  item.set("id", generateId());
  item.set("value", value);
  item.set("children", new Y.Array<Y.Map<unknown>>());
  return item;
}

function handleAppend(item: Y.Map<unknown>) {
  const children = item.get("children") as Y.Array<Y.Map<unknown>>;
  const value = item.get("value") as string;

  if (children.length > 0) {
    const lastChild = children.get(children.length - 1);
    const lastValue = lastChild.get("value") as string;
    const newValue = lastValue.replace(/\d+$/, (match: string) =>
      String(Number(match) + 1).padStart(match.length, "0"),
    );
    children.push([createItem(newValue)]);
  } else {
    children.push([createItem(`${value}.1`)]);
  }
}

function handleDelete(
  item: Y.Map<unknown>,
  parentArray: Y.Array<Y.Map<unknown>>,
) {
  const arr = parentArray.toArray();
  const idx = arr.findIndex((i) => i === item);
  if (idx !== -1) {
    parentArray.delete(idx);
  }
}

export function IndexDocYjs({
  doc,
  docId,
  setActiveDoc,
  selectedDoc,
}: {
  doc: Y.Doc;
  docId: string;
  selectedDoc?: string | undefined;
  setActiveDoc?: ((docId: string) => void) | undefined;
}) {
  const items = doc.getArray<Y.Map<unknown>>("items");
  useYjsObserver(items);

  return (
    <div className="docnode-doc text-sm">
      {/* Root level */}
      <div className="relative">
        <div
          className="docnode group relative rounded px-2 py-0.5 transition-colors"
          data-node-value="root"
        >
          <span className="inline-block truncate font-mono text-xs text-zinc-300">
            root
            <span className="ml-1 text-zinc-600">{docId.slice(-4)}</span>
          </span>
          <div className="absolute top-0 right-1 hidden flex-row gap-0.5 group-hover:flex">
            <button
              className="create rounded bg-green-600/90 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-green-500"
              onClick={() => {
                if (items.length > 0) {
                  const lastItem = items.get(items.length - 1);
                  const lastValue = lastItem.get("value") as string;
                  const newValue = lastValue.replace(/\d+$/, (match: string) =>
                    String(Number(match) + 1).padStart(match.length, "0"),
                  );
                  items.push([createItem(newValue)]);
                } else {
                  items.push([createItem("1")]);
                }
              }}
              title="Add child"
            >
              +
            </button>
            <button
              className="delete rounded bg-red-600/90 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-red-500"
              onClick={() => {
                items.delete(0, items.length);
              }}
              title="Delete all"
            >
              −
            </button>
          </div>
        </div>

        {items.toArray().map((item) => (
          <YjsNode
            key={item.get("id") as string}
            item={item}
            selectedDoc={selectedDoc}
            setActiveDoc={setActiveDoc}
            onAppend={handleAppend}
            onDelete={(child) => handleDelete(child, items)}
          />
        ))}
      </div>
    </div>
  );
}

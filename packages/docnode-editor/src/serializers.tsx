// OLD PROOF OF CONCEPT - A LOT OF THINGS ARE DIFFERENT NOW, NEED TO REVISE

// /* eslint-disable @typescript-eslint/no-unused-vars */
// import React, { type JSX } from "react";
// import { renderToString } from "react-dom/server";
// import type { BlockNode } from "./nodes.js";
// import type { DocNode } from "@docukit/docnode";

// type serializedEditor = object;
// type Converter<T extends DocNode = DocNode> = (arg: {
//   state: T["state"];
//   children: React.ReactNode;
// }) => JSX.Element;

// const BlockConverter: Converter<BlockNode> = ({ state, children }) => {
//   if (state.tag === "p") return <p>{children}</p>;
//   if (state.tag === "h1") return <h1>{children}</h1>;
//   if (state.tag === "h2") return <h2>{children}</h2>;
//   if (state.tag === "h3") return <h3>{children}</h3>;
//   if (state.tag === "h4") return <h4>{children}</h4>;
//   if (state.tag === "h5") return <h5>{children}</h5>;
//   if (state.tag === "h6") return <h6>{children}</h6>;
//   if (state.tag === "oli") return <ol>{children}</ol>;
//   if (state.tag === "uli") return <ul>{children}</ul>;
//   if (state.tag === "cli") return <li>{children}</li>;
//   state.tag satisfies never;
//   return <p>asd</p>;
// };

// /**
//  * 1. Node classes should not have any serialization method to any format. Neither html, nor DOM/JSX, nor MD, etc., to be tree-shakeable.
//  * 2. The argument should be a JSON serialization of the editor, not the editor. Again to be tree-shakeable and not need to import DocNode or the Editor.
//  * 3. The serialization must not contain prev, next, first... but they must be ordered
//  * 4. The serialization to html is going to be simply the JSX serialization with renderToString of ReactDOM.
//  *
//  * - should be UpperCase to be able to render as a react component? (e.g., <RichText />)?
//  */
// export function Editor({
//   serializedEditor,
//   converters,
// }: {
//   serializedEditor: serializedEditor;
//   converters: Converter[];
// }): React.ReactNode {
//   return <div></div>;
// }

// export function editorToHtml(serializedEditor: serializedEditor): string {
//   // @ts-expect-error - wip: Fix the type of renderToString
//   // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call
//   return renderToString(editorToJsx(serializedEditor));
// }

// export function HtmlToEditor(html: string): serializedEditor {
//   return {};
// }

// /**
//  * Si, podría usar solo la serialización de los nodos para crear el JSX como estoy prototipando en este ejemplo.
//  * Pero eso implicaría que en el editor (modo editable) que ya pagué el costo de crear las clases, tengo que pagar el
//  * costo innecesario de serializarlos a JSON. Si alguien tiene necesidades especiales como un CMS, que haga el otro serializador,
//  * o lo puedo mantener yo, pero deberían ser cosas separadas del editor en modo no readonly.
//  */

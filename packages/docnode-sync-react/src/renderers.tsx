// TODO: this is very opinionated, I'm not going to publish it in npm
// copy-paste it in the docs instead.

import type { Doc, DocNode } from "docnode";
import React, { useEffect, useReducer, type JSX } from "react";

function NodeComponent({
  node,
  render,
}: {
  node: DocNode;
  render: (args: {
    node: DocNode;
    children: JSX.Element | undefined;
  }) => React.ReactNode;
}) {
  if (!node) return null;
  const children = node.first && (
    <NodeComponent node={node.first} render={render} />
  );

  return (
    <>
      {render({ node, children })}
      {node.next && <NodeComponent node={node.next} render={render} />}
    </>
  );
}

export function DocRenderer({
  doc,
  render,
}: {
  doc: Doc;
  render: (args: {
    node: DocNode;
    children: JSX.Element | undefined;
  }) => React.ReactNode;
}) {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    return doc.onChange(forceRender);
  }, [doc]);

  return <NodeComponent node={doc.root} render={render} />;
}

function NodeComponent2({
  node,
  render,
}: {
  node: DocNode;
  render: (args: {
    node: DocNode;
    first: React.ReactNode;
    next: React.ReactNode;
  }) => React.ReactNode;
}) {
  if (!node) return null;
  const first = node.first ? (
    <NodeComponent2 node={node.first} render={render} />
  ) : null;
  const next = node.next ? (
    <NodeComponent2 node={node.next} render={render} />
  ) : null;

  return <>{render({ node, first, next })}</>;
}

export function DocRenderer2({
  doc,
  render,
}: {
  doc: Doc;
  render: (args: {
    node: DocNode;
    first: React.ReactNode;
    next: React.ReactNode;
  }) => React.ReactNode;
}) {
  return <NodeComponent2 node={doc.root} render={render} />;
}

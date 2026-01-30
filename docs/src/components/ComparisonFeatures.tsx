"use client";

import { useState, useEffect } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Hybrid component for mobile/desktop support
// Mobile devices don't have hover, so we use Popover (click-based) instead of HoverCard
// See: https://github.com/shadcn-ui/ui/issues/2402
function ClickableHoverCard({
  children,
  content,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
}) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Check if device is mobile/touch-enabled
    const checkMobile = () => {
      setIsMobile(
        "ontouchstart" in window ||
          navigator.maxTouchPoints > 0 ||
          window.matchMedia("(max-width: 768px)").matches,
      );
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Use Popover for mobile (click-based), HoverCard for desktop (hover-based)
  const sharedClassName =
    "inline cursor-help border-none bg-transparent p-0 font-inherit text-inherit text-left underline decoration-dotted";

  if (isMobile) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button className={sharedClassName}>{children}</button>
        </PopoverTrigger>
        <PopoverContent className="w-80">{content}</PopoverContent>
      </Popover>
    );
  }

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className={sharedClassName}>{children}</span>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">{content}</HoverCardContent>
    </HoverCard>
  );
}

export function TypeFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">ID-based OT vs CRDT</h4>
          <p className="text-sm">
            OT is often associated with positional operations: "insert element
            at position X". It's no surprise this is frequently criticized. When
            a long-lived branch wants to apply operations, it must transform all
            of them based on the ones it "missed", which is very slow.{" "}
            <strong>ID-based OT</strong>, however, can apply its operations
            directly (O(1)), without needing to transform them. It's basically a
            CRDT, but without P2P support in exchange for less complexity and
            metadata.
          </p>
        </div>
      }
    >
      Type
    </ClickableHoverCard>
  );
}

export function SyncBackendFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Backend Infrastructure</h4>
          <p className="text-sm">
            You can think of DocNode as an alternative to Yjs. On the other
            hand, DocSync would be to DocNode what{" "}
            <a
              href="https://tiptap.dev/docs/hocuspocus/introduction"
              className="text-blue-600 hover:underline"
            >
              Hocuspocus
            </a>{" "}
            or{" "}
            <a
              href="https://jamsocket.com/y-sweet"
              className="text-blue-600 hover:underline"
            >
              Y-Sweet
            </a>{" "}
            are to Yjs.
          </p>
        </div>
      }
    >
      Sync / Backend solution
    </ClickableHoverCard>
  );
}

export function PricingFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <p className="text-sm">
            Read our{" "}
            <a
              href="/docnode/license"
              className="text-blue-600 hover:underline"
            >
              License and Pricing page
            </a>
            .
          </p>
        </div>
      }
    >
      Pricing
    </ClickableHoverCard>
  );
}

export function LicenseFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <p className="text-sm">
            Read our{" "}
            <a
              href="/docnode/license"
              className="text-blue-600 hover:underline"
            >
              License and Pricing page
            </a>
            .
          </p>
        </div>
      }
    >
      License
    </ClickableHoverCard>
  );
}

export function TypesOfNodesFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Data Structure Types</h4>
          <p className="text-sm">
            Binding a data structure to Yjs can be complicated, as there are
            many ways to do it and each data type has its peculiarities. In
            DocNode you can define different types of nodes, but the only thing
            that changes between them is their state. In everything else, they
            are instances of DocNode, a tree node.{" "}
            <a href="/docnode/nodes" className="text-blue-600 hover:underline">
              See more in Nodes
            </a>
            .
          </p>
        </div>
      }
    >
      Types of nodes
    </ClickableHoverCard>
  );
}

export function BundleSizeFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Client-Side Package Size</h4>
          <p className="text-sm">
            The compressed size of the library when included in your application
            bundle. Smaller bundles mean faster page loads and better
            performance on mobile devices. Links for{" "}
            <a
              href="https://bundlejs.com/?q=docnode"
              className="text-blue-600 hover:underline"
            >
              DocNode
            </a>{" "}
            and{" "}
            <a
              href="https://bundlejs.com/?q=yjs"
              className="text-blue-600 hover:underline"
            >
              Yjs
            </a>{" "}
            here.
          </p>
        </div>
      }
    >
      Bundle size (gzip)
    </ClickableHoverCard>
  );
}

export function TypeSafeSchemasFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">TypeScript Type Safety</h4>
          <p className="text-sm">
            DocNode provides <strong>full TypeScript type inference</strong>{" "}
            based on your node definitions, catching errors at compile time. In
            addition, DocNode comes with State Definitions out of the box that
            serialize to super compact JSON, making your documents even smaller.
          </p>
        </div>
      }
    >
      Type-safe node schemas
    </ClickableHoverCard>
  );
}

export function MoveOperationFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Native Move Support</h4>
          <p className="text-sm">
            In Yjs you can simulate moves with delete + insert, which can result
            in duplicate nodes. This is a known and difficult-to-solve problem
            efficiently in CRDTs. Other CRDTs solve it by storing more metadata
            or operations. By requiring a central server, DocNode can solve this
            problem in the most efficient way possible.
          </p>
        </div>
      }
    >
      Move operation
    </ClickableHoverCard>
  );
}

export function HardDeletesFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">True Deletion</h4>
          <p className="text-sm">
            CRDTs use soft deletes ("tombstones") to enable P2P sync, causing
            documents to grow forever. Accidentally paste 1000 paragraphs and
            delete them? A CRDT keeps that metadata permanently. DocNode's
            server-based approach allows true deletion, keeping documents lean.
          </p>
        </div>
      }
    >
      Hard deletes
    </ClickableHoverCard>
  );
}

export function P2PSupportFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Peer-to-Peer Networking</h4>
          <p className="text-sm">
            P2P comes with tradeoffs: larger documents and more complex
            algorithms. DocNode prioritizes simplicity and efficiency with a
            server-based architecture. Need P2P for your use case? We could
            implement a CRDT mode with funding—
            <a href="/contact" className="text-blue-600 hover:underline">
              contact us
            </a>
            .
          </p>
        </div>
      }
    >
      P2P support
    </ClickableHoverCard>
  );
}

export function SchemaNormalizationFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">
            Automatic Schema Enforcement
          </h4>
          <p className="text-sm">
            Want documents to always start with a heading? Limit consecutive
            bullets to five? DocNode's Normalizers let you define custom rules
            to enforce any structure automatically.{" "}
            <a
              href="/docnode/doc-lifecycle"
              className="text-blue-600 hover:underline"
            >
              Learn more
            </a>
            .
          </p>
        </div>
      }
    >
      Schema normalization
    </ClickableHoverCard>
  );
}

export function AutomaticBatchingFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Smart Operation Batching</h4>
          <p className="text-sm">
            DocNode{" "}
            <a href="/docnode/doc-lifecycle#batching">
              automatically batches operations
            </a>{" "}
            within the same synchronous execution context, reducing overhead and
            boosting performance. No manual transaction management needed.
          </p>
        </div>
      }
    >
      Automatic batching
    </ClickableHoverCard>
  );
}

export function NodeIDsPublicFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Stable Public IDs</h4>
          <p className="text-sm">
            Every DocNode has a <strong>public, stable ID</strong> perfect for
            references, deep linking, and external integrations. Yjs uses
            internal identifiers not meant for external use.
          </p>
        </div>
      }
    >
      Node IDs are public
    </ClickableHoverCard>
  );
}

export function NoInsertsMetadataFeature() {
  return (
    <ClickableHoverCard
      content={
        <div className="prose prose-sm prose-a:text-inherit space-y-2">
          <h4 className="text-sm font-semibold">Clean Insert Operations</h4>
          <p className="text-sm">
            CRDTs require metadata not only when deleting (soft deletes /
            tombstones) or moving, but also when inserting. Nodes must preserve
            information like which nodes were adjacent at insertion time
            (OriginLeft and OriginRight in Yjs).
          </p>
        </div>
      }
    >
      Metadata-free inserts
    </ClickableHoverCard>
  );
}

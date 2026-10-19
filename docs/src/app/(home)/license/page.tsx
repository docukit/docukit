import type { Metadata } from "next";
import Link from "next/link";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { PricingCard, PricingGrid } from "@/components/PricingCard";

export const metadata: Metadata = {
  title: "License",
  description: "Usage permissions for DocNode and DocSync",
};

export default function LicensePage() {
  return (
    <div className="relative min-h-screen text-slate-200 selection:bg-emerald-500/30">
      <main className="container mx-auto max-w-4xl px-4 py-16">
        <div className="mb-12">
          <h1 className="mb-4 text-4xl font-bold">License</h1>
          <p className="text-lg text-slate-400">
            Usage permissions for DocNode and DocSync
          </p>
        </div>

        <section className="mb-16">
          <h2 className="mb-8 text-2xl font-semibold">Usage permissions</h2>
          <PricingGrid>
            <PricingCard
              title="DocNode"
              variant="emerald"
              licenseNote="Available under the MIT License."
              description="Type-safe documents with conflict resolution. Faster than any CRDT."
              features={[
                { text: "Open source and MIT licensed" },
                { text: "Full document state management" },
                { text: "Complete TypeScript support" },
                { text: "Bindings to rich text editors like Lexical" },
                { text: "Undo/redo functionality" },
                { text: "Schema validation" },
                { text: "Custom node definitions" },
              ]}
              ctaText="Get Started"
              ctaHref="/docs/getting-started"
              footer=""
            />
            <PricingCard
              title="DocSync"
              variant="blue"
              licenseNote="A separate license is required for production use."
              description="Local-first and real-time collaboration infrastructure. Source inspection for evaluation and personal, non-production use are permitted under the DocSync License."
              features={[
                { text: "WebSocket-based real-time sync" },
                { text: "IndexedDB as local persistence layer" },
                { text: "Database agnostic support via hooks" },
                { text: "Automatic reconnection" },
                { text: "History versioning" },
                { text: "Autoscaling and sharding" },
                { text: "Authentication and access control" },
                { text: "Encryption" },
                { text: "Real-time multi-tab and multi-device sync" },
                { text: "Self-hosted" },
              ]}
              ctaText="Read license"
              ctaHref="https://github.com/docukit/docukit/blob/main/packages/docsync/LICENSE.md"
              footer=""
              highlighted
            />
          </PricingGrid>
        </section>

        <section>
          <h2 className="mb-8 text-2xl font-semibold">
            Frequently Asked Questions
          </h2>
          <Accordions type="single" collapsible>
            <Accordion
              title="What is the current status of the project?"
              id="status"
            >
              <p className="mb-4">
                <strong>DocNode</strong> is very mature and in beta. The API is
                stable, though minor changes may occur before v1.0.
              </p>
              <p className="mb-4">
                <strong>DocSync</strong> is in alpha. Its API may change before
                a stable release.
              </p>
            </Accordion>

            <Accordion
              title="How does DocNode and DocSync compare to Yjs?"
              id="compare-to-yjs"
            >
              <p className="mb-4">
                You can think of DocNode as an alternative to Yjs.
              </p>
              <p>
                On the other hand, DocSync would be to DocNode what{" "}
                <a
                  href="https://tiptap.dev/docs/hocuspocus/introduction"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Hocuspocus
                </a>{" "}
                is to Yjs.
              </p>
            </Accordion>

            <Accordion
              title="What can I do without a separate DocSync license?"
              id="trial"
            >
              <p>
                You may inspect the source code for evaluation and use DocSync
                for personal, non-production projects under the DocSync License.
                Production use requires a separate license.
              </p>
            </Accordion>

            <Accordion
              title="How do I obtain permission to use DocSync in production?"
              id="request-license"
            >
              <p className="mb-4">
                All production use requires a separate license from the
                copyright holder. The permissions granted are defined by that
                license.
              </p>
              <p>
                <Link href="/contact" className="text-primary hover:underline">
                  Contact us
                </Link>{" "}
                to request authorization for your intended use.
              </p>
            </Accordion>

            <Accordion
              title="Do you offer DocSync as a cloud-based service or a hosted solution?"
              id="cloud-based-service"
            >
              <p>
                DocSync is self-hosted. Production use requires a separate
                license.
              </p>
            </Accordion>

            <Accordion
              title="Can I develop my own sync solution?"
              id="develop-own-sync"
            >
              <p className="mb-4">
                Yes. The DocNode packages are open source and MIT licensed, so
                you are free to develop your own sync solution that works with
                DocNode.
              </p>
              <p>
                This does not grant production rights to{" "}
                <code>@docukit/docsync</code>, which remains proprietary
                software under the DocSync License.
              </p>
            </Accordion>

            <Accordion title="Where can I read the license?" id="read-license">
              <p className="mb-4">
                This monorepo contains packages with two different licenses:
              </p>
              <p className="mb-4">
                <strong>DocNode packages</strong> are open source and
                distributed under the{" "}
                <a
                  href="https://github.com/docukit/docukit/blob/main/packages/docnode/LICENSE.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  MIT License
                </a>
                .
              </p>
              <p className="mb-4">
                <strong>DocSync packages</strong> are proprietary software
                distributed under the{" "}
                <a
                  href="https://github.com/docukit/docukit/blob/main/packages/docsync/LICENSE.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  DocSync License
                </a>
                . You can view the source code and use it for evaluation or
                personal non-production projects. Production use requires a
                separate license from the copyright holder.
              </p>
              <p>
                Please refer to the actual license files for complete terms.
              </p>
            </Accordion>

            <Accordion title="Can I contribute to the project?" id="contribute">
              <p>
                Absolutely! We welcome contributions to any of our libraries.
                DocNode packages are open source, DocSync packages are
                source-available, and we're happy to accept PRs, bug reports,
                and feature requests. Check out our{" "}
                <a
                  href="https://github.com/docukit/docukit"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub repository
                </a>
                .
              </p>
            </Accordion>
          </Accordions>
        </section>
      </main>
    </div>
  );
}

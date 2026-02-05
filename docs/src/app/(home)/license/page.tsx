import type { Metadata } from "next";
import Link from "next/link";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { PricingCard, PricingGrid } from "@/components/PricingCard";

export const metadata: Metadata = {
  title: "License and Pricing",
  description: "Fair pricing that grows with your success",
};

export default function LicensePage() {
  return (
    <main className="container mx-auto max-w-4xl px-4 py-16">
      <div className="mb-12">
        <h1 className="mb-4 text-4xl font-bold">License and Pricing</h1>
        <p className="text-muted-foreground text-lg">
          Fair pricing that grows with your success
        </p>
      </div>

      <section className="mb-16">
        <h2 className="mb-8 text-2xl font-semibold">Simple and Fair</h2>
        <PricingGrid>
          <PricingCard
            title="DocNode"
            price="Free"
            priceSubtext="forever"
            description="The entire library for any use, including commercial applications."
            features={[
              { text: "Full document state management" },
              { text: "Complete TypeScript support" },
              { text: "CRDT and OT modes" },
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
            price="Free"
            priceSubtext="until revenue"
            description="Local-first and real-time collaboration infrastructure. Only pay once you're making money."
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
            ctaText="Contact for Pricing"
            ctaHref="/contact"
            footer="Free for non-commercial & pre-revenue startups"
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
              stable, though minor changes may occur before v1.0. CRDT mode is
              not implemented yet.
            </p>
            <p className="mb-4">
              <strong>DocSync</strong> is in active development. Core features
              like real-time sync, persistence, and reconnection are working.
              Advanced features like autoscaling, sharding, and encryption are
              on the roadmap. <code>@docukit/docsync</code> has not yet been
              released on npm, but private distributions are offered upon
              request.
            </p>
            <p>
              We're looking for early adopters to help shape the product.{" "}
              <Link href="/contact" className="text-primary hover:underline">
                Contact us
              </Link>{" "}
              for a demo and to discuss your needs.
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
              or{" "}
              <a
                href="https://jamsocket.com/y-sweet"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Y-Sweet
              </a>{" "}
              are to Yjs.
            </p>
          </Accordion>

          <Accordion title="Can I try Sync before committing?" id="trial">
            <p>Yes! You can try it for free in non-production environments.</p>
          </Accordion>

          <Accordion
            title="Do I need to request a license to use DocSync? What if my use is non-commercial or I'm pre-revenue?"
            id="request-license"
          >
            <p className="mb-4">Yes, all production use requires a license.</p>
            <p className="mb-4">
              If your app is pre-revenue or non-commercial, you can request a
              free license. Once you start generating revenue, you'll need to
              upgrade to a commercial license.
            </p>
            <p>
              <Link href="/contact" className="text-primary hover:underline">
                Contact us
              </Link>{" "}
              to request your license.
            </p>
          </Accordion>

          <Accordion
            title="How does the pricing work? What happens if my revenues grow or fall?"
            id="pricing"
          >
            <p className="mb-4">
              We evaluate each case to ensure that pricing is accessible and
              reasonable for all companies at any stage of their development.
            </p>
            <p>Please get in touch so we can give you a quote.</p>
          </Accordion>

          <Accordion
            title="Do you offer DocSync as a cloud-based service or a hosted solution?"
            id="cloud-based-service"
          >
            <p>
              At the moment, we only offer the possibility of self-hosting under
              license. In the future, we may offer a managed hosting option.
            </p>
          </Accordion>

          <Accordion
            title="What things can I do and what things can't I do with DocNode?"
            id="do-and-dont-do-with-core"
          >
            <p className="mb-4">
              The DocNode license is very permissive and is designed so that you
              can use it free of charge for any purpose, except those that
              compete with the business model of <code>@docukit/docsync</code>.
            </p>
            <p className="mb-2">You can use DocNode to:</p>
            <ul className="mb-4 list-inside list-disc space-y-1">
              <li>
                Create local-first or real-time collaborative applications.
              </li>
              <li>Monetize these applications.</li>
              <li>
                Create and distribute DocNode-based libraries that are not
                substantially similar to or compete with the{" "}
                <code>@docukit/docsync</code> library. For example:
                DocNode-based data structures such as grids or rich text
                editors, or utilities for rendering documents in different UI
                frameworks.
              </li>
            </ul>
            <p className="mb-2">You can't use DocNode to:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>
                Distribute software that offers the same or substantially
                similar functionality as <code>@docukit/docsync</code>, such as
                libraries that synchronize or persist document state across
                multiple clients or storage systems.
              </li>
              <li>
                Offer any hosted or cloud-based service to third parties that
                provides the same or substantially similar functionality as{" "}
                <code>@docukit/docsync</code>, unless you have an explicit
                license from the copyright holder.
              </li>
            </ul>
          </Accordion>

          <Accordion
            title="Can I develop my own sync solution?"
            id="develop-own-sync"
          >
            <p className="mb-4">
              Yes. You are free to develop your own solution that synchronizes
              documents between multiple clients and stores them in your own
              databases for internal or personal use.
            </p>
            <p>
              What you can't do is distribute it to third parties or
              commercialize it as a document synchronization solution (e.g., as
              a cloud-based service).
            </p>
          </Accordion>

          <Accordion title="Where can I read the license?" id="read-license">
            <p className="mb-4">DocNode has a dual license model:</p>
            <p className="mb-4">
              <strong>DocNode packages</strong> are distributed under the{" "}
              <a
                href="https://github.com/docnode/docnode/blob/main/packages/docnode/LICENSE.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                DocNode License
              </a>
              . This license allows commercial and non-commercial use with
              minimal restrictions to protect our Sync offering, following the{" "}
              <a
                href="https://faircode.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Fair Code
              </a>{" "}
              principles.
            </p>
            <p className="mb-4">
              <strong>DocSync packages</strong> are proprietary software
              distributed under the{" "}
              <a
                href="https://github.com/docnode/docnode/blob/main/packages/docsync/LICENSE.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                DocSync License
              </a>
              . You can view the source code and use it for evaluation or
              personal non-production projects, but to use it in production you
              must request a license.
            </p>
            <p>Please refer to the actual license files for complete terms.</p>
          </Accordion>

          <Accordion title="Can I contribute to the project?" id="contribute">
            <p>
              Absolutely! We welcome contributions to all parts of DocNode.
              DocNode is source-available, and we're happy to accept PRs, bug
              reports, and feature requests. Check out our{" "}
              <a
                href="https://github.com/docnode/docnode"
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
  );
}

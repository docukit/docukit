import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description:
    "The story behind DocNode and DocSync, credits, and acknowledgements.",
};

export default function AboutPage() {
  return (
    <div className="relative min-h-screen text-slate-200 selection:bg-emerald-500/30">
      <main className="container mx-auto max-w-4xl px-4 py-16">
        <div className="mb-12">
          <h1 className="mb-4 text-4xl font-bold">About</h1>
          <p className="text-lg text-slate-400">
            The story behind DocNode and DocSync, credits, and acknowledgements.
          </p>
        </div>

        <section className="mb-16 space-y-6">
          <h2 className="text-2xl font-semibold">About Me</h2>
          <p>
            Hi, I'm{" "}
            <a
              href="https://x.com/GermanJablo"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
            >
              German Jablonski
            </a>
            , an Argentinian currently based in the UK and working on Payload
            development at Figma.
          </p>
          <p>
            I began working on DocNode in January 2024, but my fascination with
            CRDTs and OT started back in 2021, when I was building my note
            editor{" "}
            <a
              href="https://fluski.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
            >
              Fluski
            </a>
            .
          </p>
          <p>
            In Fluski, not only the text editor but also other data structures,
            like the document tree, are CRDTs. Along the way, I faced countless
            challenges. That experience pushed me to dive deep into the world of
            rich-text editors and collaborative data structures. I set up alerts
            on Google Scholar, Hacker News, and Reddit, and spent years reading
            every paper and implementation I could find.
          </p>
          <p>
            Had I known how much time and effort it would take to build DocNode,
            I probably wouldn't have been foolish enough to start it. But
            looking back, I'm glad I did. The world might have missed out on
            something truly beautiful. What kept me going was the conviction
            that there had to be a simpler way to work with conflict resolution
            in documents. That way is now real, and I hope it helps you too.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-semibold">Credits & Acknowledgements</h2>
          <p>Many thanks to:</p>
          <ul className="list-disc space-y-3 pl-6 text-slate-300">
            <li>
              The{" "}
              <a
                href="https://lexical.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Lexical
              </a>{" "}
              team, especially{" "}
              <a
                href="https://github.com/trueadm"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Dominic Gannaway
              </a>
              ,{" "}
              <a
                href="https://github.com/acywatson"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Acy Watson
              </a>
              ,{" "}
              <a
                href="https://github.com/zurfyx"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Gerard Rovira
              </a>
              ,{" "}
              <a
                href="https://github.com/fantactuka"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Maksim Horbachevsky
              </a>
              , and{" "}
              <a
                href="https://github.com/etrepum"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Bob Ippolito
              </a>
              , for the opportunity to collaborate closely and for the
              insightful discussions on Lexical's design. Special thanks to Bob,
              whose design of the new Lexical State API and the idea of Lexical
              Extensions strongly shaped DocNode's approach to state management
              and gave it its composable nature.
            </li>
            <li>
              The{" "}
              <a
                href="https://yjs.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Yjs
              </a>{" "}
              team,{" "}
              <a
                href="https://github.com/dmonad"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Kevin Jahns
              </a>{" "}
              and{" "}
              <a
                href="https://github.com/Horusiath"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Bartosz Spytkowski
              </a>
              , for their inspiring work and for sharing so many valuable
              resources through forums, blogs, and talks.
            </li>
            <li>
              The{" "}
              <a
                href="https://loro.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Loro
              </a>{" "}
              team,{" "}
              <a
                href="https://github.com/zxch3n"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Zixuan Chen
              </a>{" "}
              and{" "}
              <a
                href="https://github.com/Leeeon233"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Leon Zhao
              </a>
              , for the friendly and insightful conversations about CRDTs and
              for pushing the boundaries of what's possible with them.
            </li>
            <li>
              The research community advancing conflict resolution strategies
              for collaborative editing. Special thanks to{" "}
              <a
                href="https://github.com/ept"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Martin Kleppmann
              </a>{" "}
              and{" "}
              <a
                href="https://github.com/josephg"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Joseph Gentle
              </a>{" "}
              for their impactful contributions.
            </li>
            <li>
              State management libraries:{" "}
              <a
                href="https://jotai.org/docs/core/atom"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Jotai
              </a>
              ,{" "}
              <a
                href="https://zustand.docs.pmnd.rs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Zustand
              </a>
              , and{" "}
              <a
                href="https://pinia.vuejs.org/core-concepts/#Setup-Stores"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
              >
                Pinia
              </a>
              , which inspired the way to customize getters and setters in
              DocNode.
            </li>
            <li>
              To my beautiful wife Normi, for supporting me unconditionally in
              this and all my projects.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}

/** Browser-only: `vitest/browser` cannot be imported from Node test files. */
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    /** Defined in vitest.config.ts. */
    forgetServerDoc: (docId: string) => Promise<void>;
  }
}

/** Makes the test server lose a doc, as when its copy expires. */
export const forgetServerDoc = (docId: string) =>
  commands.forgetServerDoc(docId);

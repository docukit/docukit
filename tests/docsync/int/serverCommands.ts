/** Browser-only: `vitest/browser` cannot be imported from Node test files. */
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    /** Defined in vitest.config.ts. */
    forgetServerDoc: (docId: string) => Promise<void>;
    startDocSyncServer: () => Promise<number>;
    restartDocSyncServer: (port: number) => Promise<void>;
    stopDocSyncServer: (port: number) => Promise<void>;
  }
}

/**
 * A DocSync server only the calling test uses. `restart` closes it and opens
 * a new one on the same port and storage, like a process restart.
 */
export const startOwnServer = async () => {
  const port = await commands.startDocSyncServer();
  return {
    port,
    restart: () => commands.restartDocSyncServer(port),
    stop: () => commands.stopDocSyncServer(port),
  };
};

/** Makes the test server lose a doc, as when its copy expires. */
export const forgetServerDoc = (docId: string) =>
  commands.forgetServerDoc(docId);

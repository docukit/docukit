import { DocNodeBinding } from "@docukit/docsync2/docnode";
import { createTestDocSyncClient } from "./client.js";
import { createTestDocArgs } from "./generators.js";

export const createTestDocNodeClient = () => {
  const docArgs = createTestDocArgs();
  const docBinding = DocNodeBinding([{ type: docArgs.type, extensions: [] }]);
  return { ...createTestDocSyncClient(docBinding), docArgs };
};

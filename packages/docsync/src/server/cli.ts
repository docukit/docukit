import { PostgresProvider } from "./providers/postgres/index.js";
import { DocSyncServer } from "./index.js";
import { DocNodeBinding } from "../exports/docnode.js";

new DocSyncServer({
  docBinding: DocNodeBinding([]),
  port: 8081,
  provider: PostgresProvider,
  authenticate: async () => ({ userId: "John" }),
});

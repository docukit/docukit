import { PostgresProvider } from "./providers/postgres/index.js";
import { DocSyncServer } from "./index.js";

new DocSyncServer({
  port: 8081,
  provider: PostgresProvider,
  authenticate: async () => ({ userId: "John" }),
});

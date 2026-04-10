import { postgresProvider } from "./providers/postgres/index.js";
import { DocSyncServer } from "./index.js";
import { DocNodeBinding } from "../exports/docnode.js";

new DocSyncServer({
  docBinding: DocNodeBinding([]),
  port: 8081,
  provider: postgresProvider({
    url: "postgres://docukit:docukit@localhost:5433/docukit",
  }),
  authenticate: () => ({ userId: "John" }),
});

import { DocNodeServer, PostgresProvider } from "@docnode/sync-react/server";

new DocNodeServer({ port: 8081, provider: PostgresProvider });

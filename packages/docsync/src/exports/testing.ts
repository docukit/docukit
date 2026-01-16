/**
 * Testing utilities - exports that don't require external dependencies like PostgreSQL
 */
export { DocSyncServer } from "../server/index.js";
export type { ServerConfig } from "../server/types.js";
export { InMemoryServerProvider } from "../server/providers/memory.js";

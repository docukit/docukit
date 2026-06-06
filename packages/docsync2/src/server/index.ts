import { notImplemented } from "../shared/notImplemented.js";

export type DocSync2ServerConfig = { port?: number };

export class DocSync2Server {
  constructor(public readonly config: DocSync2ServerConfig = {}) {}

  close(): Promise<void> {
    return Promise.reject(notImplemented());
  }
}

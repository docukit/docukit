import { notImplemented } from "../shared/notImplemented.js";
import {
  isGetDocData,
  type GetDocData,
} from "../shared/validators/getDocData.js";
import { isGetDocKey, type GetDocKey } from "../shared/validators/getDocKey.js";

export type DocSync2ServerConfig = { port?: number };

export class DocSync2Server {
  constructor(public readonly config: DocSync2ServerConfig = {}) {}

  close(): Promise<void> {
    return Promise.reject(notImplemented());
  }

  protected _isGetDocData(value: unknown): value is GetDocData {
    return isGetDocData(value);
  }

  protected _isGetDocKey(value: unknown): value is GetDocKey {
    return isGetDocKey(value);
  }
}

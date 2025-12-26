// This is a client provider that, instead of storing information locally,
// requests it from the server. It's useful if your focus isn't local-first
// or local-only, but server-only.
// It won't work without an internet connection.

import type { ClientProvider, TransactionContext } from "../types.js";
import type { API } from "../utils.js";

export class RemoteProvider<S, O> implements ClientProvider<S, O> {
  private _api: API<S, O>;

  constructor(api: API<S, O>) {
    this._api = api;
  }

  transaction<T>(
    _mode: "readonly" | "readwrite",
    _callback: (ctx: TransactionContext<S, O>) => Promise<T>,
  ): Promise<T> {
    throw new Error("not implemented yet");
  }
}

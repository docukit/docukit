// This is a client provider that, instead of storing information locally,
// requests it from the server. It's useful if your focus isn't local-first
// or local-only, but server-only.
// It won't work without an internet connection.

import type { OpsPayload, SerializedDocPayload } from "../../shared/types.js";
import type { ClientProvider } from "../types.js";
import type { API } from "../utils.js";

export class RemoteProvider<S, O> implements ClientProvider<S, O> {
  private _api: API<S, O>;

  constructor(api: API<S, O>) {
    this._api = api;
  }

  async getSerializedDoc(
    _docId: string,
  ): Promise<{ serializedDoc: S; clock: number } | undefined> {
    throw new Error("not implemented yet");
  }

  getOperations({ docId: _docId }: { docId: string }): Promise<O[]> {
    throw new Error("not implemented yet");
  }
  deleteOperations({
    docId: _docId,
    count: _count,
  }: {
    docId: string;
    count: number;
  }): Promise<void> {
    throw new Error("not implemented yet");
  }
  saveOperations(_arg: OpsPayload<O>): Promise<void> {
    throw new Error("not implemented yet");
  }
  saveSerializedDoc(_arg: SerializedDocPayload<S>): Promise<void> {
    throw new Error("not implemented yet");
  }
}

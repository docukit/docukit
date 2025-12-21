/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  ClientSocket,
  OpsPayload,
  SerializedDocPayload,
} from "../shared/types.js";
import { io } from "socket.io-client";
import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import { DocStore } from "./docStore.js";

export type BroadcastMessage<O> = {
  type: "OPERATIONS";
  operations: O;
  docId: string;
};

export type ClientConfig<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> = {
  url: string;
  docBinding: DocBinding<D, S, O>;
  auth: {
    /**
     * Server authentication token.
     *
     * - Passed verbatim to the server on connection.
     * - Validation is delegated to the server via `onAuth`.
     * - This library does not issue, refresh, or rotate tokens.
     */
    getToken: () => Promise<string>;
  };
  local?: {
    provider: new () => ClientProvider<S, O>;
    /**
     * Resolves the local storage identity.
     *
     * Used exclusively for:
     * - Namespacing local persistence (userId)
     * - Deriving encryption keys for data at rest (secret)
     *
     * About the secret:
     * - Must never be persisted client-side (localStorage, IndexedDB, etc).
     * - Re-encryption is not supported, so losing the secret makes local data permanently unrecoverable.
     *
     */
    getIdentity: () => Promise<{
      userId: string;
      secret: string;
    }>;
  };
};

export type ClientProvider<S, O> = {
  getSerializedDoc(docId: string): Promise<{ serializedDoc: S } | undefined>;
  getOperations(): Promise<OpsPayload<O>[]>;
  deleteOperations(count: number): Promise<void>;
  saveOperations(arg: OpsPayload<O>): Promise<void>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
};

export class DocSyncClient<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> {
  private _docBinding: DocBinding<D, S, O>;
  docStore: DocStore<D, S, O>;
  private _local?: {
    provider: ClientProvider<S, O>;
    secret: Promise<string>;
  };
  private _shouldBroadcast = true;
  private _broadcastChannel: BroadcastChannel;

  // ws
  private _socket: ClientSocket<S, O>;
  protected _pushStatus: "idle" | "pushing" | "pushing-with-pending" = "idle";

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const { docBinding, local } = config;
    this._docBinding = docBinding;
    if (local)
      this._local = {
        secret: local.getIdentity().then((identity) => identity.secret),
        provider: new local.provider(),
      };

    this._socket = io(config.url, {
      auth: {
        userId: "John Salchichon",
        token: "1234567890",
      },
    });
    // prettier-ignore
    {
    this._socket.on("connect", () => console.log("Connected to Socket.io server"));
    this._socket.on("connect_error", err => console.error("Socket.io connection error:", err));
    this._socket.on("disconnect", reason => console.error("Socket.io disconnected:", reason));
    }
    this.docStore = new DocStore<D, S, O>({
      docBinding,
      localProvider: this._local?.provider,
      onChangeDoc: (doc, docId) => {
        this._docBinding.onChange(doc, ({ operations }) => {
          if (this._shouldBroadcast) {
            this._sendMessage({
              type: "OPERATIONS",
              operations,
              docId,
            });
            void this.onLocalOperations({ docId, operations, doc });
          }
          this._shouldBroadcast = true;
        });
      },
    });

    // Listen for operations from other tabs.
    this._broadcastChannel = new BroadcastChannel("docsync");
    this._broadcastChannel.onmessage = async (
      ev: MessageEvent<BroadcastMessage<O>>,
    ) => {
      if (ev.data.type === "OPERATIONS") {
        void this._applyOperations(ev.data.operations, ev.data.docId);
        return;
      }
      ev.data.type satisfies never;
    };
  }

  async _applyOperations(operations: O, docId: string) {
    const doc = await this.docStore.getDocFromCache(docId);
    if (!doc) return;
    this._shouldBroadcast = false;
    this._docBinding.applyOperations(doc, operations);
  }

  _sendMessage(message: BroadcastMessage<O>) {
    this._broadcastChannel.postMessage(message);
  }

  async onLocalOperations({
    docId,
    operations,
    doc,
  }: OpsPayload<O> & { doc: D }) {
    await this._local?.provider.saveOperations({ docId, operations });
    if (this._pushStatus !== "idle") this._pushStatus = "pushing-with-pending";

    const pushOperations = async () => {
      if (this._pushStatus !== "idle")
        throw new Error("Push already in progress");
      // prevent narrowing for security due to async mutation scenario. TS trade-off.
      // https://github.com/microsoft/TypeScript/issues/9998
      this._pushStatus = "pushing" as DocSyncClient<D, S, O>["_pushStatus"];
      const allOperations = (await this._local?.provider.getOperations()) ?? [];
      // Acá puedo llegar a tener que devolver el documento completo si hubo concurrencia
      const [error, _newOperations] =
        await this._pushOperationsToServer(allOperations);
      if (error) {
        // retry. Maybe I should consider throw the error depending on the error type
        // to avoid infinite loops
        this._pushStatus = "idle";
        await pushOperations();
      } else {
        // TODO: como hago en deleteOperations de indexedDB si quizás mientras viajaba al servidor y volvía
        // hubo otras operaciones que escribieron en idb?
        // 2 stores? Almacenar el id de la última operación enviada?
        await this._local?.provider.deleteOperations(allOperations.length);
        await this._local?.provider.saveSerializedDoc({
          serializedDoc: this._docBinding.serialize(doc),
          docId,
        });

        // Status may have changed to "pushing-with-pending" during async ops
        const shouldPushAgain = this._pushStatus === "pushing-with-pending";
        this._pushStatus = "idle";
        if (shouldPushAgain) await pushOperations();
      }
    };
    if (this._pushStatus === "idle") await pushOperations();
  }

  private async _pushOperationsToServer(
    ops: OpsPayload<O>[],
  ): Promise<[Error, undefined] | [undefined, OpsPayload<O>[]]> {
    const response = await new Promise<OpsPayload<O>[] | Error>((resolve) => {
      this._socket.emit("operations", ops, (res: OpsPayload<O>[] | Error) => {
        resolve(res);
      });
    });
    if (response instanceof Error) return [response, undefined];
    return [undefined, response];
  }
}

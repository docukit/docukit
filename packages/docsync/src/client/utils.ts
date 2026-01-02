import { io } from "socket.io-client";
import type {
  ClientSocket,
  DocSyncEventName,
  DocSyncEvents,
} from "../shared/types.js";

export type APIOptions = {
  url: string;
  getToken: () => Promise<string>;
  onDirty?: (payload: { docId: string }) => void;
  onReconnect?: () => void;
};

export class API<S, O> {
  protected _socket: ClientSocket<S, O>;

  constructor(options: APIOptions) {
    this._socket = io(options.url, {
      auth: (cb) => {
        void options.getToken().then((token) => cb({ token }));
      },
      // Performance optimizations for testing
      transports: ["websocket"], // Skip polling, go straight to WebSocket
    });
    // prettier-ignore
    {
      this._socket.on("connect", () => {
        // console.log("Connected to Socket.io server");
        // Notify reconnection so subscriptions can be restored
        options.onReconnect?.();
      });
      // this._socket.on("connect_error", err => console.error("Socket.io connection error:", err));
      // this._socket.on("disconnect", reason => console.error("Socket.io disconnected:", reason));
    }

    // Listen for dirty notifications from server
    if (options.onDirty) {
      this._socket.on("dirty", options.onDirty);
    }
  }

  request<E extends DocSyncEventName>(
    event: E,
    payload: DocSyncEvents<S, O>[E]["request"],
  ): Promise<DocSyncEvents<S, O>[E]["response"]> {
    type Emit = <K extends DocSyncEventName>(
      event: K,
      payload: DocSyncEvents<S, O>[K]["request"],
      cb: (res: DocSyncEvents<S, O>[K]["response"]) => void,
    ) => void;
    return new Promise((resolve) => {
      (this._socket.emit as Emit)(event, payload, resolve);
    });
  }
}

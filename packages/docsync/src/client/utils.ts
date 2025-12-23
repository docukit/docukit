import { io } from "socket.io-client";
import type {
  ClientSocket,
  DocSyncEventName,
  DocSyncEvents,
} from "../shared/types.js";

export class API<S, O> {
  private _socket: ClientSocket<S, O>;

  constructor(options: { url: string }) {
    this._socket = io(options.url, {
      auth: { userId: "John", token: "1234567890" },
    });
    // prettier-ignore
    {
      this._socket.on("connect", () => console.log("Connected to Socket.io server"));
      this._socket.on("connect_error", err => console.error("Socket.io connection error:", err));
      this._socket.on("disconnect", reason => console.error("Socket.io disconnected:", reason));
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

import { io } from "socket.io-client";
import type {
  ClientSocket,
  DocSyncEventName,
  DocSyncEvents,
} from "../shared/types.js";

/**
 * Get or create a unique device ID stored in localStorage.
 * This ID is shared across all tabs/windows on the same device.
 */
function getDeviceId(): string {
  const key = "docsync:deviceId";
  let deviceId = localStorage.getItem(key);
  if (!deviceId) {
    // Generate a new device ID using crypto.randomUUID()
    deviceId = crypto.randomUUID();
    localStorage.setItem(key, deviceId);
  }
  return deviceId;
}

export type APIOptions = {
  url: string;
  getToken: () => Promise<string>;
  onDirty?: (payload: { docId: string }) => void;
  onReconnect?: () => void;
  onDisconnect?: () => void;
};

export class API<S, O> {
  protected _socket: ClientSocket<S, O>;

  constructor(options: APIOptions) {
    // Capture deviceId once at creation time, not on every reconnection
    const deviceId = getDeviceId();

    this._socket = io(options.url, {
      auth: (cb) => {
        void options.getToken().then((token) => {
          cb({ token, deviceId });
        });
      },
      // Performance optimizations for testing
      transports: ["websocket"], // Skip polling, go straight to WebSocket
    });

    // Listen to server debug logs (for testing/debugging)
    this._socket.on("_log", (debugLog) => {
      console.log("[🔍 SERVER]", JSON.stringify(debugLog));
    });

    // prettier-ignore
    {
      this._socket.on("connect", () => {
        // console.log("Connected to Socket.io server");
        // Notify reconnection so subscriptions can be restored
        options.onReconnect?.();
      });
      this._socket.on("disconnect", () => {
        // Reset any pending operations when socket disconnects
        options.onDisconnect?.();
      });
      // this._socket.on("connect_error", err => console.error("Socket.io connection error:", err));
    }

    // Listen for dirty notifications from server
    if (options.onDirty) {
      this._socket.on("dirty", options.onDirty);
    }
  }

  disconnect() {
    this._socket.disconnect();
  }

  connect() {
    this._socket.connect();
  }

  async request<E extends DocSyncEventName>(
    event: E,
    payload: DocSyncEvents<S, O>[E]["request"],
  ): Promise<DocSyncEvents<S, O>[E]["response"]> {
    type Emit = <K extends DocSyncEventName>(
      event: K,
      payload: DocSyncEvents<S, O>[K]["request"],
      cb: (res: DocSyncEvents<S, O>[K]["response"]) => void,
    ) => void;

    // TO-DO: should I reject on disconnect?
    return new Promise((resolve, reject) => {
      // Add a timeout to prevent hanging forever if socket disconnects during request
      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout: ${event}`));
      }, 5000); // 5 second timeout

      (this._socket.emit as Emit)(event, payload, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }
}

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Provider, ProviderAwareness, UserState } from "@lexical/yjs";

/**
 * A Yjs provider adapter that bridges DocSync with @lexical/yjs CollaborationPlugin.
 *
 * DocSync handles the actual document sync (network, persistence, conflict resolution).
 * This provider satisfies the interface that @lexical/yjs expects, making DocSync
 * a drop-in replacement for y-websocket or other Yjs providers.
 *
 * It uses a separate "editor Y.Doc" for the CollaborationPlugin and keeps it
 * bidirectionally synced with the DocSync-managed Y.Doc. This is necessary because
 * the CollaborationPlugin only observes changes that occur AFTER its binding is set up,
 * but the DocSync Y.Doc may already have content from IndexedDB or server sync.
 */
export class DocSyncYjsProvider implements Provider {
  awareness: ProviderAwareness;

  /** The Y.Doc managed by DocSync (source of truth). */
  private _sourceDoc: Y.Doc;
  /** The Y.Doc used by Lexical's CollaborationPlugin. */
  private _editorDoc: Y.Doc;
  private _connected = false;

  private _listeners = {
    sync: new Set<(isSynced: boolean) => void>(),
    update: new Set<(arg0: unknown) => void>(),
    status: new Set<(arg0: { status: string }) => void>(),
    reload: new Set<(doc: Y.Doc) => void>(),
  };

  /**
   * @param sourceDoc The Y.Doc managed by DocSync.
   * @param editorDoc A fresh Y.Doc for the CollaborationPlugin. Must be set in yjsDocMap.
   */
  constructor(sourceDoc: Y.Doc, editorDoc: Y.Doc) {
    this._sourceDoc = sourceDoc;
    this._editorDoc = editorDoc;

    const rawAwareness = new Awareness(editorDoc);
    this.awareness = {
      // eslint-disable-next-line @typescript-eslint/no-restricted-types -- Awareness.getLocalState() returns null
      getLocalState: () => rawAwareness.getLocalState() as UserState | null,
      getStates: () => rawAwareness.getStates() as Map<number, UserState>,
      setLocalState: (state: UserState) => rawAwareness.setLocalState(state),
      setLocalStateField: (field: string, value: unknown) =>
        rawAwareness.setLocalStateField(field, value),
      on: (_type: "update", cb: () => void) => rawAwareness.on("update", cb),
      off: (_type: "update", cb: () => void) => rawAwareness.off("update", cb),
    };
  }

  connect(): void {
    if (this._connected) return;
    this._connected = true;

    // Sync source → editor: apply the full state of the DocSync doc to the editor doc.
    // Because the editor doc starts empty, this triggers Y.Doc change events that
    // the CollaborationPlugin's binding observes and syncs to Lexical.
    const sourceState = Y.encodeStateAsUpdate(this._sourceDoc);
    Y.applyUpdate(this._editorDoc, sourceState, "docsync-bridge");

    // Set up bidirectional sync between source and editor docs.
    this._sourceDoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "docsync-bridge") return;
      Y.applyUpdate(this._editorDoc, update, "docsync-bridge");
    });
    this._editorDoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "docsync-bridge") return;
      Y.applyUpdate(this._sourceDoc, update, "docsync-bridge");
    });

    // Signal readiness to the CollaborationPlugin.
    // Use setTimeout so the binding's observers are fully set up.
    setTimeout(() => {
      this._emit("status", { status: "connected" });
      this._emit("sync", true);
    }, 0);
  }

  disconnect(): void {
    this._emit("status", { status: "disconnected" });
  }

  on(type: "sync", cb: (isSynced: boolean) => void): void;
  on(type: "status", cb: (arg0: { status: string }) => void): void;
  on(type: "update", cb: (arg0: unknown) => void): void;
  on(type: "reload", cb: (doc: Y.Doc) => void): void;
  on(type: keyof typeof this._listeners, cb: never): void {
    (this._listeners[type] as Set<typeof cb>).add(cb);
  }

  off(type: "sync", cb: (isSynced: boolean) => void): void;
  off(type: "update", cb: (arg0: unknown) => void): void;
  off(type: "status", cb: (arg0: { status: string }) => void): void;
  off(type: "reload", cb: (doc: Y.Doc) => void): void;
  off(type: keyof typeof this._listeners, cb: never): void {
    (this._listeners[type] as Set<typeof cb>).delete(cb);
  }

  private _emit(type: "sync", ...args: [boolean]): void;
  private _emit(type: "status", ...args: [{ status: string }]): void;
  private _emit(type: "update", ...args: [unknown]): void;
  private _emit(type: "reload", ...args: [Y.Doc]): void;
  private _emit(type: string, ...args: unknown[]): void {
    const set = this._listeners[type as keyof typeof this._listeners];
    if (set) {
      for (const cb of set) {
        (cb as (...a: unknown[]) => void)(...args);
      }
    }
  }
}

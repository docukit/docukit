"use client";

import { useEffect, useState } from "react";
import { clearDemoIndexedDB } from "@/lib/synced-editors-demo/createTwoClients";

const DEMO_BC_NAME = "docukit-synced-editors-demo";
const PING_WAIT_MS = 200;

/**
 * Returns true when the demo can create clients. Uses BroadcastChannel to
 * detect other tabs: only clears IndexedDB when this tab is alone, so multiple
 * tabs can share the same demo DB without one clearing under the other.
 */
export function useDemoIndexedDBReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const channel = new BroadcastChannel(DEMO_BC_NAME);
    const tabId = crypto.randomUUID();
    let otherTabReplied = false;

    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; tabId?: string } | undefined;
      if (!msg) return;
      if (msg.type === "ping" && msg.tabId !== tabId) {
        channel.postMessage({ type: "pong", tabId });
      }
      if (msg.type === "pong" && msg.tabId !== tabId) {
        otherTabReplied = true;
      }
    };

    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "ping", tabId });

    const timeoutId = setTimeout(() => {
      const clearPromise = otherTabReplied
        ? Promise.resolve()
        : clearDemoIndexedDB();
      clearPromise.then(() => setReady(true)).catch(console.error);
    }, PING_WAIT_MS);

    // Keep channel open so we keep responding to pings from tabs that open
    // later; otherwise the second tab would get no pong and hang on clear.
    return () => {
      clearTimeout(timeoutId);
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, []);

  return ready;
}

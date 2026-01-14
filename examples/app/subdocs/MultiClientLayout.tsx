"use client";

import { type ReactNode, useState } from "react";
import type { referenceClient } from "./ClientProviders";

interface MultiClientLayoutProps {
  children: (clientId: string, userId: string) => ReactNode;
  referenceClient: typeof referenceClient;
  otherTabClient: typeof referenceClient;
  otherDeviceClient: typeof referenceClient;
}

export function MultiClientLayout({
  children,
  referenceClient,
  otherTabClient,
  otherDeviceClient,
}: MultiClientLayoutProps) {
  const [referenceConnected, setReferenceConnected] = useState(true);
  const [otherTabConnected, setOtherTabConnected] = useState(true);
  const [otherDeviceConnected, setOtherDeviceConnected] = useState(true);

  const toggleReference = () => {
    if (!referenceClient) return;
    if (referenceConnected) {
      referenceClient["_api"].disconnect();
    } else {
      referenceClient["_api"].connect();
    }
    setReferenceConnected(!referenceConnected);
  };

  const toggleOtherTab = () => {
    if (!otherTabClient) return;
    if (otherTabConnected) {
      otherTabClient["_api"].disconnect();
    } else {
      otherTabClient["_api"].connect();
    }
    setOtherTabConnected(!otherTabConnected);
  };

  const toggleOtherDevice = () => {
    if (!otherDeviceClient) return;
    if (otherDeviceConnected) {
      otherDeviceClient["_api"].disconnect();
    } else {
      otherDeviceClient["_api"].connect();
    }
    setOtherDeviceConnected(!otherDeviceConnected);
  };
  return (
    <div className="flex w-full gap-4 p-4">
      {/* Reference Client - User 1 */}
      <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/30 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-700 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-emerald-400">
              Reference
            </h2>
            <button
              onClick={toggleReference}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                referenceConnected
                  ? "bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                  : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
              }`}
              title={
                referenceConnected
                  ? "Disconnect from server"
                  : "Connect to server"
              }
            >
              {referenceConnected ? "🟢 Online" : "🔴 Offline"}
            </button>
          </div>
          <span className="text-xs text-zinc-500">User 1 • Device A</span>
        </div>
        {children("reference", "user1")}
      </div>

      {/* Other Tab - User 1 (same user, different tab) */}
      <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/30 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-700 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-blue-400">Other Tab</h2>
            <button
              onClick={toggleOtherTab}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                otherTabConnected
                  ? "bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                  : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
              }`}
              title={
                otherTabConnected
                  ? "Disconnect from server"
                  : "Connect to server"
              }
            >
              {otherTabConnected ? "🟢 Online" : "🔴 Offline"}
            </button>
          </div>
          <span className="text-xs text-zinc-500">User 1 • Device A</span>
        </div>
        {children("otherTab", "user1")}
      </div>

      {/* Other Device - User 2 (different user, different device) */}
      <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/30 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-700 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-purple-400">
              Other Device
            </h2>
            <button
              onClick={toggleOtherDevice}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                otherDeviceConnected
                  ? "bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                  : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
              }`}
              title={
                otherDeviceConnected
                  ? "Disconnect from server"
                  : "Connect to server"
              }
            >
              {otherDeviceConnected ? "🟢 Online" : "🔴 Offline"}
            </button>
          </div>
          <span className="text-xs text-zinc-500">User 2 • Device B</span>
        </div>
        {children("otherDevice", "user2")}
      </div>
    </div>
  );
}

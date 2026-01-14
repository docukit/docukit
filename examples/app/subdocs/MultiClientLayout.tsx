"use client";

import { type ReactNode } from "react";

interface MultiClientLayoutProps {
  children: (clientId: string, userId: string) => ReactNode;
}

export function MultiClientLayout({ children }: MultiClientLayoutProps) {
  return (
    <div className="flex min-h-screen w-full gap-4 p-4">
      {/* Reference Client - User 1 */}
      <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/30 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-700 pb-2">
          <h2 className="text-sm font-semibold text-emerald-400">Reference</h2>
          <span className="text-xs text-zinc-500">User 1 • Device A</span>
        </div>
        {children("reference", "user1")}
      </div>

      {/* Other Tab - User 1 (same user, different tab) */}
      <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/30 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-700 pb-2">
          <h2 className="text-sm font-semibold text-blue-400">Other Tab</h2>
          <span className="text-xs text-zinc-500">User 1 • Device A</span>
        </div>
        {children("otherTab", "user1")}
      </div>

      {/* Other Device - User 2 (different user, different device) */}
      <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/30 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-zinc-700 pb-2">
          <h2 className="text-sm font-semibold text-purple-400">
            Other Device
          </h2>
          <span className="text-xs text-zinc-500">User 2 • Device B</span>
        </div>
        {children("otherDevice", "user2")}
      </div>
    </div>
  );
}

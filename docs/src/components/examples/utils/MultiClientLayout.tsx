"use client";

import { type ReactNode, useState } from "react";
import type { DocSyncClient } from "@docukit/docsync-react/client";
import { cn } from "@/lib/cn";

function ConnectionToggle({
  connected,
  onClick,
  testId,
}: {
  connected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "border-fd-border hover:bg-fd-accent inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
        connected ? "text-fd-primary" : "text-destructive",
      )}
      title={connected ? "Disconnect from server" : "Connect to server"}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          connected ? "bg-fd-primary" : "bg-destructive",
        )}
      />
      {connected ? "Online" : "Offline"}
    </button>
  );
}

export function MultiClientLayout({
  children,
  referenceClient,
  otherTabClient,
  otherDeviceClient,
}: {
  children: (clientId: string, userId: string) => ReactNode;
  referenceClient: DocSyncClient | undefined;
  otherTabClient: DocSyncClient | undefined;
  otherDeviceClient: DocSyncClient | undefined;
}) {
  const [referenceConnected, setReferenceConnected] = useState(true);
  const [otherTabConnected, setOtherTabConnected] = useState(true);
  const [otherDeviceConnected, setOtherDeviceConnected] = useState(true);

  const toggleReference = () => {
    if (!referenceClient) return;
    if (referenceConnected) {
      referenceClient.disconnect();
    } else {
      referenceClient.connect();
    }
    setReferenceConnected(!referenceConnected);
  };

  const toggleOtherTab = () => {
    if (!otherTabClient) return;
    if (otherTabConnected) {
      otherTabClient.disconnect();
    } else {
      otherTabClient.connect();
    }
    setOtherTabConnected(!otherTabConnected);
  };

  const toggleOtherDevice = () => {
    if (!otherDeviceClient) return;
    if (otherDeviceConnected) {
      otherDeviceClient.disconnect();
    } else {
      otherDeviceClient.connect();
    }
    setOtherDeviceConnected(!otherDeviceConnected);
  };
  return (
    <div className="grid w-full grid-cols-1 gap-4 pb-6 lg:grid-cols-3">
      {/* Reference Client - User 1 */}
      <div className="border-fd-border bg-fd-card min-w-0 rounded-lg border p-4">
        <div className="border-fd-border mb-4 flex items-center justify-between gap-3 border-b pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-fd-foreground text-sm font-semibold">
              Reference
            </h2>
            <ConnectionToggle
              onClick={toggleReference}
              connected={referenceConnected}
              testId="reference-connection-toggle"
            />
          </div>
          <span className="text-fd-muted-foreground shrink-0 text-xs">
            User 1 • Device A
          </span>
        </div>
        <div id="reference">{children("reference", "user1")}</div>
        {/* Hidden duplicate for testing multiple useDoc calls */}
        <div id="reference-hidden" className="hidden">
          {children("reference", "user1")}
        </div>
      </div>

      {/* Other Tab - User 1 (same user, different tab) */}
      <div className="border-fd-border bg-fd-card min-w-0 rounded-lg border p-4">
        <div className="border-fd-border mb-4 flex items-center justify-between gap-3 border-b pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-fd-foreground text-sm font-semibold">
              Other Tab
            </h2>
            <ConnectionToggle
              onClick={toggleOtherTab}
              connected={otherTabConnected}
              testId="otherTab-connection-toggle"
            />
          </div>
          <span className="text-fd-muted-foreground shrink-0 text-xs">
            User 1 • Device A
          </span>
        </div>
        <div id="otherTab">{children("otherTab", "user1")}</div>
        {/* Hidden duplicate for testing multiple useDoc calls */}
        <div id="otherTab-hidden" className="hidden">
          {children("otherTab", "user1")}
        </div>
      </div>

      {/* Other Device - User 2 (different user, different device) */}
      <div className="border-fd-border bg-fd-card min-w-0 rounded-lg border p-4">
        <div className="border-fd-border mb-4 flex items-center justify-between gap-3 border-b pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-fd-foreground text-sm font-semibold">
              Other Device
            </h2>
            <ConnectionToggle
              onClick={toggleOtherDevice}
              connected={otherDeviceConnected}
              testId="otherDevice-connection-toggle"
            />
          </div>
          <span className="text-fd-muted-foreground shrink-0 text-xs">
            User 2 • Device B
          </span>
        </div>
        <div id="otherDevice">{children("otherDevice", "user2")}</div>
        {/* Hidden duplicate for testing multiple useDoc calls */}
        <div id="otherDevice-hidden" className="hidden">
          {children("otherDevice", "user2")}
        </div>
      </div>
    </div>
  );
}

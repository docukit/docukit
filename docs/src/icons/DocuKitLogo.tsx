import React from "react";
import DocNodeLogo from "./DocNodeLogo";
import DocSyncLogo from "./DocSyncLogo";
import DocEditorLogo from "./DocEditorLogo";
import DocGridLogo from "./DocGridLogo";

export default function DocuKitLogo({ className }: { className?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-1 ${className}`}>
      <DocNodeLogo className="h-auto w-full" />
      <DocSyncLogo className="h-auto w-full" />
      <DocEditorLogo className="h-auto w-full" />
      <DocGridLogo className="h-auto w-full" />
    </div>
  );
}

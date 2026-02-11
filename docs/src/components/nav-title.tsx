"use client";

import { usePathname } from "next/navigation";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";
import DocEditorLogo from "@/icons/DocEditorLogo";
import DocGridLogo from "@/icons/DocGridLogo";

export function NavTitle() {
  const pathname = usePathname();

  if (pathname.startsWith("/docnode")) {
    return <DocNodeLogo className="h-6 w-auto" />;
  }
  if (pathname.startsWith("/docsync")) {
    return <DocSyncLogo className="h-6 w-auto" />;
  }
  if (pathname.startsWith("/doceditor")) {
    return <DocEditorLogo className="h-6 w-auto" />;
  }
  if (pathname.startsWith("/docgrid")) {
    return <DocGridLogo className="h-6 w-auto" />;
  }

  return null;
}

"use client";

import { usePathname } from "next/navigation";
import DocNodeLogo from "@/icons/DocNodeLogo";
import DocSyncLogo from "@/icons/DocSyncLogo";
import DocEditorLogo from "@/icons/DocEditorLogo";
import DocGridLogo from "@/icons/DocGridLogo";
import DocuKitFaviconCircles from "@/icons/DocuKitFaviconCircles";

export function NavTitle() {
  const pathname = usePathname();

  if (pathname.startsWith("/docs/docnode")) {
    return <DocNodeLogo className="h-6 w-auto" />;
  }
  if (pathname.startsWith("/docs/docsync")) {
    return <DocSyncLogo className="h-6 w-auto" />;
  }
  if (pathname.startsWith("/docs/doceditor")) {
    return <DocEditorLogo className="h-6 w-auto" />;
  }
  if (pathname.startsWith("/docs/docgrid")) {
    return <DocGridLogo className="h-6 w-auto" />;
  }

  return <DocuKitFaviconCircles className="h-6 w-6" />;
}

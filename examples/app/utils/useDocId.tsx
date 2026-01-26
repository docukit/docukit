"use client";

import { useLayoutEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ulid } from "ulid";

/**
 * Hook to ensure a docId exists in the URL.
 * If no docId is provided, it automatically redirects to a new one.
 *
 * @param basePath - The base path for the redirect (e.g., "/editor", "/subdocs")
 * @returns The docId from the URL, or undefined if redirecting
 */
export function useDocId(basePath: string) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const docId = searchParams.get("docId");

  // Use useLayoutEffect to redirect before browser paint
  useLayoutEffect(() => {
    if (!docId) {
      const newDocId = ulid().toLowerCase();
      void router.replace(`${basePath}?docId=${newDocId}`);
    }
  }, [docId, router, basePath]);

  return docId ?? null;
}

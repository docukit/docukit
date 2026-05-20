import { ulid } from "ulid";

const DOC_ID_PATTERN = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export function createDocId(): string {
  return ulid().toLowerCase();
}

export function isValidDocId(docId: string): boolean {
  return DOC_ID_PATTERN.test(docId);
}

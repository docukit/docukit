import { ulid } from "ulid";

let testUserCounter = 0;

export const generateTestUserId = () =>
  `docsync-test-user-${Date.now()}-${++testUserCounter}`;

export const generateDocId = () => ulid().toLowerCase();

export const createTestDocArgs = () => ({ type: "note", id: generateDocId() });

import { describe, test } from "vitest";

// ============================================================================
// ServerSync Tests
// ============================================================================
// Note: ServerSync is an internal class not exported from @docnode/docsync/client.
// These tests are planned for when the class is exported or tested through integration.

describe("ServerSync", () => {
  describe("saveRemote", () => {
    test.todo("should call _doPush when status is idle");

    test.todo(
      "should set status to pushing-with-pending when called during a push",
    );

    test.todo("should allow concurrent pushes for different docIds");
  });

  describe("_doPush", () => {
    test.todo("should get operations from provider");

    test.todo("should send operations to API via sync-operations");

    test.todo("should retry on API failure");

    test.todo("should delete operations after successful push");

    test.todo("should consolidate operations into serialized doc after push");

    test.todo("should retry if more operations were queued during push");

    test.todo("should do nothing if no operations to push");
  });
});

// ============================================================================
// Planned tests from DocSyncClient review:
// ============================================================================

// onLocalOperations tests (delegated from DocSyncClient):
// "should save operations to provider" → tested through _doPush
// "should set _inLocalWaiting when push is already in progress" → "pushing-with-pending" status
// "should push operations to server when not in progress" → _doPush tests
// "should retry push when server returns error" → _doPush retry test
// "should delete operations from provider after successful push" → _doPush test
// "should save updated jsonDoc after successful push" → consolidate test
// "should push again if operations were queued during push" → retry test

// Socket.io integration tests (via API class):
// These would require more complex mocking of the API class
// "should connect to socket.io server on initialization"
// "should handle socket connection errors"
// "should handle socket disconnection"

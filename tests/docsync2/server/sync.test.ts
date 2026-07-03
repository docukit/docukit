import { describe, test } from "vitest";

describe("sync", () => {
  // TODO: ValidationError events are hard to test without either mocking the
  // socket layer or importing a raw protocol client. Both are options we want
  // to avoid here.
  test.todo("invalid operations return ValidationError and are not persisted");
});

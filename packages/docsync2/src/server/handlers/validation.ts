export const createValidationError = (error: unknown) => {
  return {
    type: "ValidationError" as const,
    message: error instanceof Error ? error.message : String(error),
  };
};

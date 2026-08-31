// Shared vitest setup. Nothing global is required yet - individual test files mock their own
// dependencies (Mongo models, ai-brain-service HTTP calls, etc.) rather than relying on a real
// database connection, so there is no per-suite connect/disconnect to do here.
export {};

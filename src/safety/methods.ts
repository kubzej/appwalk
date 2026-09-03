export const DEFAULT_BLOCK_METHODS = ["POST", "DELETE", "PUT", "PATCH"] as const;

export function normalizeBlockMethods(methods: readonly string[]): string[] {
  return [...new Set(methods.map((method) => method.trim().toUpperCase()))];
}

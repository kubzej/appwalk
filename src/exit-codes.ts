/** Process exit codes shared by the report contract and top-level CLI failures. */
export const EXIT_CODES = {
  success: 0,
  findings: 1,
  executionError: 2,
  inconclusive: 3,
} as const;

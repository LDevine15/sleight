// Native metadata failures, never exception text or document content.
export const CLOSE_COUNT_REASONS = Object.freeze([
  'lease-invalid', 'process-changed', 'ax-error', 'ax-invalid', 'cg-error', 'cg-invalid',
  'predicate-error', 'cgs-unbound', 'cgs-error', 'cgs-invalid', 'deadline', 'helper-error',
]);

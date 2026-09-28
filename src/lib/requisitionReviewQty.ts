// Empty number inputs must not silently become 0 (a cancelled order line).
export function parseReviewQty(value: string | undefined): number {
  return value?.trim() ? Number(value) : Number.NaN;
}

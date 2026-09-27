/** Format a price-spike alert for display without changing its stored rate. */
export function formatAlertRate(value: number | string): string {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return String(value);
  return `₹${rate.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

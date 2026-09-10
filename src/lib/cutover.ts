// 13-18 August were the on-site trial. Operational screens and business
// reports start from the clean go-live on 19 August; the old ledger remains
// intact for audit and for the opening shelf balance.
export const REPORTING_CUTOVER_DATE = "2026-08-19";
export const REPORTING_CUTOVER_TIMESTAMP = "2026-08-18T18:30:00.000Z";

export function clampToCutover(value?: string) {
  if (!value || value < REPORTING_CUTOVER_DATE) return REPORTING_CUTOVER_DATE;
  return value;
}

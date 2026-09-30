export type StockAlertValues = {
  canteen_id: string | null;
  ingredient_id: string | null;
  created_at: string;
  expected_value: number | string | null;
  actual_value: number | string | null;
  loss_value: number | string | null;
};

export type StockMovement = {
  id: string;
  canteen_id: string;
  ingredient_id: string;
  reference_type: string | null;
  change_qty: number | string;
  balance_after: number | string;
  reason: string | null;
  created_at: string;
  created_by: string | null;
};

export function findStockAlertMovement(alert: StockAlertValues, movements: StockMovement[]): StockMovement | undefined {
  if (!alert.canteen_id || !alert.ingredient_id || alert.expected_value == null || alert.actual_value == null) return undefined;
  const expected = Number(alert.expected_value);
  const actual = Number(alert.actual_value);
  const alertTime = Date.parse(alert.created_at);
  if (![expected, actual, alertTime].every(Number.isFinite)) return undefined;
  return movements
    .filter((movement) => {
      const secondsApart = Math.abs(Date.parse(movement.created_at) - alertTime) / 1000;
      return movement.canteen_id === alert.canteen_id
        && movement.ingredient_id === alert.ingredient_id
        && (movement.reference_type === "audit" || movement.reference_type === "manual")
        && Number.isFinite(secondsApart) && secondsApart <= 120
        && Math.abs(Number(movement.balance_after) - actual) < 0.001
        && Math.abs(Number(movement.change_qty) - (actual - expected)) < 0.001;
    })
    .sort((a, b) => Math.abs(Date.parse(a.created_at) - alertTime) - Math.abs(Date.parse(b.created_at) - alertTime))[0];
}

export function stockAlertRate(alert: StockAlertValues): number | undefined {
  if (alert.expected_value == null || alert.actual_value == null || alert.loss_value == null) return undefined;
  const difference = Math.abs(Number(alert.actual_value) - Number(alert.expected_value));
  const loss = Number(alert.loss_value);
  if (!Number.isFinite(difference) || !Number.isFinite(loss) || difference <= 0 || loss < 0) return undefined;
  return loss / difference;
}

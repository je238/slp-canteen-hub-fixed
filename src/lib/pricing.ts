// Single source of truth for order pricing. POS, QR ordering and the
// QR order hook must all bill from the same numbers.
export const GST_RATE = 0.05;

export function gstAmount(subtotal: number): number {
  return Math.round(subtotal * GST_RATE);
}

export function orderTotals(subtotal: number) {
  const gst = gstAmount(subtotal);
  return { subtotal, gst, total: subtotal + gst };
}

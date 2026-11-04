export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function money(value: unknown): number {
  const n = Number(value);
  requireThat(
    Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000,
    "Invalid minor-unit amount",
  );
  return n;
}
export function settlementMath(
  balance: number,
  unpaid: number,
  late: number,
  platform: number,
  debt: number,
  penalty: number,
) {
  const net = balance - unpaid - late - platform - debt - penalty;
  return {
    collateral_balance: balance,
    unpaid_contributions: unpaid,
    late_fees: late,
    platform_fees: platform,
    outstanding_debt: debt,
    exit_penalty: penalty,
    refund: Math.max(0, net),
    debt: Math.max(0, -net),
  };
}
export function holdback(pot: number, future: number, collateral: number) {
  return Math.min(pot, Math.max(0, future - collateral));
}

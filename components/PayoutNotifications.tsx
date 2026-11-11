import type { Payout } from "./types";

const purposes: Record<string, string> = {
  winner: "Circle payout",
  dividend: "Discount share",
  retention_release: "Retained funds released",
  refund: "Settlement refund",
};

export default function PayoutNotifications({
  payouts,
  memberId,
  currency,
  simulated,
}: {
  payouts: Payout[];
  memberId: string;
  currency: string;
  simulated: boolean;
}) {
  const received = payouts.filter(
    (payout) => payout.member_id === memberId && payout.status === "succeeded",
  );
  if (!received.length) return null;
  return (
    <section className="card" aria-label="Received payments" aria-live="polite">
      <span className="eyebrow">{simulated ? "DEMO PAYMENTS" : "PAYPAL RECEIPTS"}</span>
      <h2>{simulated ? "Your simulated payouts" : "You’ve received funds"}</h2>
      {received.map((payout) => (
        <article key={payout.id} className="notice">
          <strong>
            {purposes[payout.purpose] || "Payment"}:{" "}
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency,
            }).format(Number(payout.amount) / 100)}
          </strong>
          <p>
            {simulated ? (
              "Credited in the simulation. No money was transferred."
            ) : (
              <>
                PayPal confirmed delivery to{" "}
                <strong>{payout.receiver || "your registered PayPal account"}</strong>.
                This payment is in your PayPal account, separate from your TrustCircle
                collateral.
              </>
            )}
          </p>
          {!simulated && payout.item_id && (
            <small>PayPal payout item: {payout.item_id}</small>
          )}
        </article>
      ))}
      {!simulated && (
        <>
          <a
            href="https://www.sandbox.paypal.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            View funds in PayPal Sandbox ↗
          </a>
          <p>
            Sign in with the receiving Personal sandbox account shown above. These are
            test funds and cannot be withdrawn to a real bank account.
          </p>
        </>
      )}
    </section>
  );
}

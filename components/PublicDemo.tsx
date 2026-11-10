"use client";
import { useEffect, useState } from "react";
import Grid from "./Grid";
import {
  demoStep,
  initialDemo,
  type DemoAction,
  type DemoTransaction,
} from "../lib/demo";
const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );
export default function PublicDemo() {
  const [state, setState] = useState(initialDemo);
  const [selected, setSelected] = useState(0);
  const [discount, setDiscount] = useState("100");
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      setState((previous) =>
        previous.deadline && time >= previous.deadline
          ? demoStep(previous, { type: "tick" }, time)
          : previous,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  function act(action: DemoAction) {
    setNow(Date.now());
    setState((previous) => demoStep(previous, action, Date.now()));
  }
  function fill(kind: "deposit" | "pay", exceptLast = false) {
    setNow(Date.now());
    setState((previous) =>
      previous.members.reduce(
        (next, _, member) =>
          exceptLast && member === 4
            ? next
            : demoStep(next, { type: kind, member }, Date.now()),
        previous,
      ),
    );
  }
  const member = state.members[selected];
  const seconds = state.deadline
    ? Math.max(0, Math.ceil((state.deadline - now) / 1000))
    : 0;
  return (
    <main className="entry-shell demo-shell">
      <header className="entry-header">
        <a className="brand" href="/">
          ◉ TrustCircle
        </a>
        <a href="/">Create your account ↗</a>
      </header>
      <div className="notice" role="status">
        <b>INTERACTIVE SIMULATION</b> · No PayPal account required. No money moves.
        Refreshing resets this preview.
      </div>
      <section className="demo-heading">
        <div>
          <span className="eyebrow">EXPERIENCE BEFORE YOU INVEST</span>
          <h1>
            A circle you can
            <br />
            <span>see working.</span>
          </h1>
          <p>
            Five people. Clear rules. Follow every decision and every simulated dollar.
          </p>
        </div>
        <button
          onClick={() => {
            setState(initialDemo());
            setSelected(0);
          }}
        >
          Reset walkthrough ↺
        </button>
      </section>
      <div className="demo-steps">
        {["deposits", "collecting", "bidding", "settled"].map((phase, index) => (
          <span key={phase} className={state.phase === phase ? "active" : ""}>
            {index + 1}. {phase}
          </span>
        ))}
      </div>
      <div className="demo-stats">
        <section className="card">
          <small>ROUND</small>
          <h2>{state.round} / 2 preview</h2>
        </section>
        <section className="card">
          <small>FUNDED POT</small>
          <h2>{money(state.members.filter((member) => member.paid).length * 50000)}</h2>
        </section>
        <section className="card">
          <small>
            {state.phase === "bidding" ? "REQUEST WINDOW" : "PAYMENT + GRACE"}
          </small>
          <h2>{state.deadline ? `${seconds}s` : "—"}</h2>
        </section>
        <section className="card">
          <small>SIMULATED PAYOUTS</small>
          <h2>
            {money(state.members.reduce((total, member) => total + member.received, 0))}
          </h2>
        </section>
      </div>
      <div className="demo-columns">
        <section className="card">
          <span className="eyebrow">STEP INTO A MEMBER’S SHOES</span>
          <h2>Your circle</h2>
          <div className="demo-members">
            {state.members.map((person, index) => (
              <button
                key={person.name}
                className={selected === index ? "selected" : ""}
                onClick={() => setSelected(index)}
                aria-pressed={selected === index}
              >
                <span className="avatar">{person.name[0]}</span>
                {person.name}
                <small>
                  {person.barred
                    ? "Barred after two defaults"
                    : person.won
                      ? "Already won"
                      : person.paid
                        ? "Paid this round"
                        : person.deposited
                          ? "Deposit ready"
                          : "Awaiting deposit"}
                </small>
              </button>
            ))}
          </div>
          <h3>{member.name}’s account</h3>
          <p>
            Collateral: {money(member.collateral)} · Received: {money(member.received)}
          </p>
          {member.notice && (
            <div className="alert" role="alert">
              {member.notice}
            </div>
          )}
          {state.phase === "deposits" && (
            <>
              <p>Each member deposits $1,500 as collateral with the Treasurer.</p>
              <button
                className="primary"
                disabled={member.deposited}
                onClick={() => act({ type: "deposit", member: selected })}
              >
                Okay, simulate my deposit
              </button>
              <button onClick={() => fill("deposit")}>
                Complete all five deposits →
              </button>
            </>
          )}
          {state.phase === "collecting" && (
            <>
              <p>
                Contribute $500. After the 55-second payment and grace period, missed
                payments are covered from collateral.
              </p>
              <button
                className="primary"
                disabled={member.paid}
                onClick={() => act({ type: "pay", member: selected })}
              >
                Simulate my $500 payment
              </button>
              <div className="demo-actions">
                <button onClick={() => fill("pay")}>Everyone pays →</button>
                <button onClick={() => fill("pay", true)}>
                  Pay for everyone except Sara
                </button>
                <button
                  onClick={() =>
                    setState((previous) =>
                      demoStep(
                        { ...previous, deadline: Date.now() },
                        { type: "tick" },
                        Date.now(),
                      ),
                    )
                  }
                >
                  Skip to grace deadline
                </button>
              </div>
            </>
          )}
          {state.phase === "bidding" && (
            <>
              <p>
                Request this payout at $0 discount, or offer a discount. The highest
                discount wins and is split equally among the other four members.
              </p>
              {member.won ? (
                <p className="notice">
                  You already received a payout in this circle and cannot request again.
                </p>
              ) : (
                <label>
                  Discount offered (USD)
                  <input
                    type="number"
                    min="0"
                    max="2499.99"
                    step="0.01"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={
                      !discount ||
                      !Number.isFinite(Number(discount)) ||
                      Number(discount) < 0 ||
                      Number(discount) >= 2500
                    }
                    onClick={() =>
                      act({
                        type: "bid",
                        member: selected,
                        discount: Math.round(Number(discount) * 100),
                      })
                    }
                  >
                    Submit payout request
                  </button>
                  <small>
                    Your current offer:{" "}
                    {member.discount === null ? "No request" : money(member.discount)}
                  </small>
                </label>
              )}
              <button
                onClick={() =>
                  setState((previous) =>
                    demoStep(
                      { ...previous, deadline: Date.now() },
                      { type: "tick" },
                      Date.now(),
                    ),
                  )
                }
              >
                Skip the wait and settle →
              </button>
            </>
          )}
          {state.phase === "paused" && (
            <div className="alert" role="alert">
              Circle paused: a member reached two payment defaults and is barred.
              Remaining collateral is preserved. Reset the walkthrough to explore another
              scenario.
            </div>
          )}
          {state.phase === "settled" && (
            <>
              <p>
                Settlement complete. Inspect the transaction history below.
                {state.round === 1
                  ? " Try round 2 to see why a previous winner cannot claim again."
                  : " You’ve completed the guided preview."}
              </p>
              {state.round === 1 ? (
                <button className="primary" onClick={() => act({ type: "next" })}>
                  Explore round 2 →
                </button>
              ) : (
                <a className="primary" href="/">
                  Create your account →
                </a>
              )}
            </>
          )}
        </section>
        <section className="card">
          <span className="eyebrow">THE TREASURER’S DECISIONS</span>
          <h2>Rules you can follow.</h2>
          <p>This walkthrough uses local rules, not a live AI or PayPal connection.</p>
          <ol className="decision-feed">
            {state.decisions.map((decision, index) => (
              <li key={`${state.decisions.length - index}-${decision}`}>{decision}</li>
            ))}
          </ol>
        </section>
      </div>
      <section className="card">
        <h2>Every movement, on the record.</h2>
        <p>Simulated amounts in USD. Filter, sort, search or export the ledger.</p>
        <Grid<DemoTransaction>
          name="Demo transactions"
          rows={state.transactions}
          columns={[
            { field: "sequence", headerName: "#", maxWidth: 95, minWidth: 70 },
            { field: "member" },
            { field: "kind", minWidth: 240 },
            {
              field: "amount",
              headerName: "Amount (USD)",
              valueFormatter: (params) => money(params.value || 0),
            },
          ]}
        />
      </section>
    </main>
  );
}

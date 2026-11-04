"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Grid from "./Grid";
import type { Session, Snapshot, Config, Account, Ledger, Payout, Member } from "./types";
type Order = {
  id: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  paypal_id: string | null;
  capture_id: string | null;
  provider_status: string | null;
  last_error: string | null;
  approval_url: string | null;
};
type State = Snapshot & { ownOrders: Order[] };
export default function Dashboard() {
  const [session, setSession] = useState<Session | null>(null),
    [data, setData] = useState<State | null>(null),
    [account, setAccount] = useState<Account | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [tab, setTab] = useState("Overview"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [now, setNow] = useState(Date.now()),
    [settlement, setSettlement] = useState<Record<string, unknown> | null>(null);
  const current = useRef<Session | null>(null),
    request = useRef(0),
    inFlight = useRef(false),
    loading = useRef<{ token: string; serial: number } | null>(null);
  const [registration, setRegistration] = useState({
    name: "",
    email: "",
    token: "",
    circle: "",
  });
  const [circleName, setCircleName] = useState("Builders Circle");
  const mode = "auction";
  const [bid, setBid] = useState("0");
  const [depositProposal, setDepositProposal] = useState<{
    id: string;
    member_id: string;
    amount: number;
    currency: string;
  } | null>(null);
  const [depositConfirmation, setDepositConfirmation] = useState("");
  useEffect(() => {
    setDepositProposal(null);
    setDepositConfirmation("");
    setBid("0");
  }, [session?.memberId]);
  async function api<T>(
    url: string,
    body?: unknown,
    token = current.current?.token,
  ): Promise<T> {
    const r = await fetch("/api" + url, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await r.json();
    if (!r.ok) throw Error(value.error || "Request failed");
    return value;
  }
  const save = useCallback((s: Session | null) => {
    request.current++;
    current.current = s;
    setSession(s);
    setData(null);
    setAccount(null);
    setSettlement(null);
    setError("");
    setNotice("");
    if (s) sessionStorage.setItem("tc-next-session", JSON.stringify(s));
    else sessionStorage.removeItem("tc-next-session");
  }, []);
  const refresh = useCallback(async () => {
    const s = current.current;
    if (!s || loading.current?.token === s.token) return;
    const serial = ++request.current;
    loading.current = { token: s.token, serial };
    try {
      const [state, me] = await Promise.all([
        api<State>("/circles/" + s.circleId, undefined, s.token),
        api<Account>("/me", undefined, s.token),
      ]);
      if (current.current?.token !== s.token || serial !== request.current) return;
      setData(state);
      setAccount(me);
    } finally {
      if (loading.current?.serial === serial) loading.current = null;
    }
  }, []);
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("tc-next-session");
      if (s) save(JSON.parse(s));
    } catch {
      sessionStorage.removeItem("tc-next-session");
    }
    api<Config>("/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [save]);
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const update = () =>
      refresh().catch((e) => {
        if (!stopped) setError(e.message);
      });
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session, refresh]);
  async function run(fn: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!session) return;
    const query = new URLSearchParams(location.search);
    if (query.has("cancelled")) {
      setNotice(
        "PayPal checkout was cancelled. No payment is recorded until PayPal confirms capture. You can resume checkout from Transactions.",
      );
      history.replaceState({}, "", location.pathname);
    }
    const id = query.get("order");
    if (id) {
      history.replaceState({}, "", location.pathname);
      void run(async () => {
        const result = await api<{ status: string }>("/orders/" + id + "/capture", {});
        setNotice(
          result.status === "completed"
            ? "PayPal payment verified and credited."
            : "PayPal payment is awaiting approval or settlement. The Treasurer will check automatically.",
        );
      });
    }
  }, [session]);
  const me = data?.members.find((m) => m.id === session?.memberId),
    cycle = data?.cycles.at(-1);
  const money = (n: unknown) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: data?.circle.currency || config?.currency || "INR",
    }).format(Number(n || 0) / 100);
  async function pay(kind: string, id = session!.memberId, token = session!.token) {
    const o = await api<{ id: string; approval_url?: string }>(
      `/members/${id}/orders`,
      { kind, key: crypto.randomUUID() },
      token,
    );
    if (config?.demo) await api(`/orders/${o.id}/capture`, {}, token);
    else if (o.approval_url) location.assign(o.approval_url);
    else throw Error("PayPal did not return an approval link");
  }
  async function startDemo() {
    const d = await api<{
      circle: { id: string };
      members: NonNullable<Session["members"]>;
    }>("/demo", {});
    save({
      circleId: d.circle.id,
      memberId: d.members[0].id,
      token: d.members[0].token,
      members: d.members,
    });
  }
  async function register() {
    const u = registration.token
      ? { token: registration.token }
      : await api<{ token: string }>("/register", {
          name: registration.name,
          email: registration.email,
        });
    let circleId = registration.circle;
    if (circleId) await api(`/circles/${circleId}/join`, {}, u.token);
    else {
      const ci = await api<{ id: string }>(
        "/circles",
        { name: circleName, contribution: 50000, n_members: 5, mode },
        u.token,
      );
      circleId = ci.id;
    }
    const [s, a] = await Promise.all([
      api<State>("/circles/" + circleId, undefined, u.token),
      api<Account>("/me", undefined, u.token),
    ]);
    const member = s.members.find(
      (m) => (m as Member & { user_id: string }).user_id === a.id,
    );
    if (!member) throw Error("Member not found");
    save({ token: u.token, circleId, memberId: member.id });
  }
  const deductions =
    data?.ledger.filter(
      (l) =>
        l.member_id === session?.memberId &&
        ["default_coverage", "late_fee", "retention_coverage"].includes(l.kind),
    ) || [];
  const left = cycle
    ? Math.max(
        0,
        Math.ceil(
          (+new Date(cycle.request_closes_at || cycle.grace_end_at) - now) / 1000,
        ),
      )
    : 0;
  if (config?.setupPending) {
    return (
      <main className="card" style={{ maxWidth: 720, margin: "10vh auto", padding: 40 }}>
        <span className="eyebrow">TRUSTCIRCLE · PAYPAL SANDBOX</span>
        <h1>Your circle is almost ready.</h1>
        <p>
          The app is online. PayPal setup is still in progress, so registration and
          transfers are currently unavailable.
        </p>
        <p>Please return once setup is complete.</p>
      </main>
    );
  }
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          ◉{" "}
          <span>
            TrustCircle<small>AUTONOMOUS TREASURER</small>
          </span>
        </a>
        <div className="workspace">YOUR CIRCLE</div>
        <nav>
          {["Overview", "Members", "Transactions", "Treasurer"].map((t, i) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={tab === t ? "selected" : ""}
            >
              <span>{["▦", "♧", "⇄", "✧"][i]}</span>
              {t}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <b>Rules before transfers.</b>
          <p>
            PayPal Agent Toolkit
            <br />
            AG Grid · Next.js 16
          </p>
        </div>
        {session && <button onClick={() => save(null)}>Sign out</button>}
      </aside>
      <main>
        <header>
          <span>Every transfer, accounted for.</span>
          <div className="header-right">
            <span className="mode">
              {config?.demo ? "SIMULATED MONEY" : "PAYPAL SANDBOX"}
            </span>
            <span className="avatar">{me?.name[0] || "T"}</span>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {!session ? (
            <>
              <section className="welcome">
                <span className="eyebrow">AUTOMATION YOU CAN AUDIT</span>
                <h1>
                  Your circle.
                  <br />
                  Always in motion.
                </h1>
                <p>
                  One Treasurer account. Five independent members.
                  <br />
                  Automatic collections, transparent decisions.
                </p>
                {config?.demo && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => run(startDemo)}
                  >
                    Start two-minute demo ↗
                  </button>
                )}
                <small>
                  Demo cycle: 25 seconds to pay + 30 seconds grace + 60 seconds for payout
                  requests.
                  <br />
                  Payouts are simulated; real PayPal settlement timing is external.
                </small>
              </section>
              <section className="card">
                <h2>Connect your sandbox member</h2>
                <p>
                  Each member uses their own PayPal sandbox account. Never share PayPal
                  passwords here.
                </p>
                <div className="formgrid">
                  {(["name", "email", "token", "circle"] as const).map((k) => (
                    <label key={k}>
                      {
                        {
                          name: "Name",
                          email: "Your PayPal sandbox email",
                          token: "Saved member token (optional)",
                          circle: "Circle invite ID (optional)",
                        }[k]
                      }
                      <input
                        type={k === "token" ? "password" : "text"}
                        value={registration[k]}
                        onChange={(e) =>
                          setRegistration({
                            ...registration,
                            [k]: e.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    New circle name
                    <input
                      value={circleName}
                      onChange={(e) => setCircleName(e.target.value)}
                    />
                  </label>
                  <p>
                    Winner policy: member requests and discount bidding, with rotation
                    fallback. A 60-second request window opens after the pot is funded.
                  </p>
                </div>
                <button disabled={busy} onClick={() => run(register)}>
                  Register / join circle
                </button>
              </section>
            </>
          ) : (
            <>
              <div className="title-row">
                <div>
                  <span className="eyebrow">{tab.toUpperCase()}</span>
                  <h1>{data?.circle.name || "Switching member…"}</h1>
                  <p>
                    {me?.name || "Loading your account"} ·{" "}
                    {data?.circle.status || "Please wait"}
                  </p>
                </div>
                {session.members && (
                  <label>
                    Viewing as
                    <select
                      aria-label="Viewing as"
                      disabled={busy}
                      value={session.memberId}
                      onChange={(e) => {
                        const m = session.members!.find((m) => m.id === e.target.value)!;
                        save({ ...session, memberId: m.id, token: m.token });
                      }}
                    >
                      {session.members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {data && me && (
                <>
                  {deductions.length > 0 && (
                    <div className="alert" role="alert">
                      <b>{me.name}, your held deposit was used for a late payment.</b>
                      <br />
                      {money(deductions.reduce((n, l) => n + Number(l.amount), 0))}{" "}
                      deducted across your recorded contributions and fees. Your remaining
                      collateral is {money(me.collateral)}. These are internal allocations
                      from funds already held by the Treasurer—not another debit from your
                      personal PayPal account.
                    </div>
                  )}
                  {tab === "Overview" && (
                    <>
                      <section className="circle-banner">
                        <div>
                          <span className="eyebrow">THE TREASURER IS ON DUTY</span>
                          <h2>
                            {cycle && data.circle.status === "active"
                              ? `Cycle ${cycle.n} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
                              : "Build trust. Move together."}
                          </h2>
                          <p>
                            {cycle
                              ? cycle.request_closes_at
                                ? "Time left to request the pot or update a discount. Settlement follows automatically."
                                : "Contribution deadline and grace. Once the pot is funded, the payout request window opens."
                              : "The timer begins only after all five collateral deposits are verified."}
                          </p>
                          <span className="banner-tag">
                            ◇ Funded pots only · No manual winner overrides
                          </span>
                        </div>
                      </section>
                      <section className="stats">
                        <div className="stat">
                          <span>YOUR HELD DEPOSIT</span>
                          <h2>{money(me.collateral)}</h2>
                          <p>{money(me.retention)} additional retention</p>
                        </div>
                        <div className="stat">
                          <span>CURRENT POT</span>
                          <h2>{money(cycle?.pot)}</h2>
                          <p>
                            Target{" "}
                            {money(
                              Number(data.circle.contribution) * data.circle.n_members,
                            )}
                          </p>
                        </div>
                        <div className="stat">
                          <span>YOUR TRUST SCORE</span>
                          <h2>{me.trust_score}/100</h2>
                          <p>Payment history, not a credit bureau rating</p>
                        </div>
                      </section>
                      <section className="card">
                        <h2>Your account → Treasurer → Winner</h2>
                        <p>
                          Your private receiver: <strong>{account?.paypal_email}</strong>
                        </p>
                        <p>
                          Treasurer: <strong>{config?.treasury}</strong>
                        </p>
                        <p>
                          {config?.demo
                            ? "No money is held at PayPal in this demo. All five member balances and transfers are simulated."
                            : "Approved deposits and contributions are captured into the configured PayPal business balance. Winner payouts originate from that same business account."}
                        </p>
                        <div className="actions">
                          <button
                            className="primary"
                            disabled={busy || me.status === "exited"}
                            onClick={() =>
                              run(async () => {
                                if (data.circle.status === "forming") {
                                  const proposal = await api<{
                                    id: string;
                                    member_id: string;
                                    amount: number;
                                    currency: string;
                                  }>(`/members/${me.id}/deposit-proposal`, {});
                                  setDepositProposal(proposal);
                                  setDepositConfirmation("");
                                } else await pay("contribution");
                              })
                            }
                          >
                            {data.circle.status === "forming"
                              ? "Deposit collateral"
                              : "Pay this cycle"}{" "}
                            ↗
                          </button>
                          <button
                            disabled={busy || me.status === "exited"}
                            onClick={() => run(() => pay("topup"))}
                          >
                            Top up deposit
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(data.circle.id);
                              setNotice("Invite ID copied");
                            }}
                          >
                            Copy circle invite
                          </button>
                        </div>
                      </section>
                      {session.members && config?.demo && (
                        <section className="demo-controls">
                          <b>Simulation controls</b>
                          <p>
                            Fund all deposits to activate. Pay everyone except Sara to
                            demonstrate an automatic deduction and user-specific banner.
                          </p>
                          <div className="actions">
                            <button
                              disabled={busy || data.circle.status !== "forming"}
                              onClick={() =>
                                run(async () => {
                                  for (const m of session.members!)
                                    if (
                                      data.members.find((x) => x.id === m.id)
                                        ?.collateral === 0
                                    )
                                      await pay("collateral", m.id, m.token);
                                })
                              }
                            >
                              Fund all deposits
                            </button>
                            <button
                              disabled={busy || data.circle.status !== "active"}
                              onClick={() =>
                                run(async () => {
                                  for (const m of session.members!.filter(
                                    (m) => m.name !== "Sara",
                                  ))
                                    if (
                                      cycle?.contributions.find(
                                        (c) => c.member_id === m.id,
                                      )?.status === "pending"
                                    )
                                      await pay("contribution", m.id, m.token);
                                })
                              }
                            >
                              Everyone except Sara pays
                            </button>
                          </div>
                        </section>
                      )}
                    </>
                  )}
                  {(tab === "Members" || tab === "Overview") && (
                    <section className="card">
                      <h2>Your circle</h2>
                      <Grid<Member>
                        name="members"
                        rows={data.members}
                        columns={[
                          { field: "name", pinned: "left" },
                          { field: "slot", headerName: "Rotation slot" },
                          {
                            field: "collateral",
                            valueFormatter: (p) => money(p.value),
                          },
                          {
                            field: "retention",
                            valueFormatter: (p) => money(p.value),
                          },
                          { field: "trust_score", headerName: "Trust score" },
                          {
                            field: "has_won",
                            headerName: "Already received pot",
                          },
                          { field: "status" },
                        ]}
                      />
                    </section>
                  )}
                  {tab === "Transactions" && (
                    <>
                      {!config?.demo &&
                        data.ownOrders
                          .filter((order) => order.status !== "completed")
                          .map((order) => (
                            <section className="card" key={order.id}>
                              <h3>
                                {order.kind} · {money(order.amount)}
                              </h3>
                              <p>
                                PayPal status:{" "}
                                {order.provider_status || "Awaiting checkout creation"}
                              </p>
                              {order.last_error && (
                                <p role="status">{order.last_error}</p>
                              )}
                              {order.approval_url && (
                                <a href={order.approval_url}>Resume PayPal approval</a>
                              )}
                              <button
                                disabled={busy || !order.paypal_id}
                                onClick={() =>
                                  run(async () => {
                                    const result = await api<{ status: string }>(
                                      `/orders/${order.id}/capture`,
                                      {},
                                    );
                                    setNotice(
                                      result.status === "completed"
                                        ? "PayPal payment verified and credited."
                                        : `PayPal payment: ${result.status}. Funds are credited only after completion.`,
                                    );
                                  })
                                }
                              >
                                Check / complete approved payment
                              </button>
                            </section>
                          ))}

                      <section className="card">
                        <h2>Your PayPal collections</h2>
                        <p>
                          {config?.demo
                            ? "Simulated member → Treasurer transfers"
                            : "Your private PayPal account → Treasurer business balance"}
                        </p>
                        <Grid<Order>
                          name="collections"
                          rows={data.ownOrders || []}
                          columns={[
                            { field: "kind" },
                            {
                              field: "amount",
                              valueFormatter: (p) => money(p.value),
                            },
                            { field: "status" },
                            {
                              field: "paypal_id",
                              headerName: "PayPal order ID",
                            },
                            { field: "capture_id", headerName: "Capture ID" },
                            { field: "provider_status", headerName: "PayPal status" },
                            { field: "last_error", headerName: "Payment issue" },
                          ]}
                        />
                      </section>
                      <section className="card">
                        <h2>Your received / pending payouts</h2>
                        <p>
                          Treasurer → {account?.paypal_email} ·{" "}
                          {config?.demo ? "Simulation" : "PayPal sandbox"}
                        </p>
                        <Grid<Payout>
                          name="payouts"
                          rows={data.payouts.filter((p) => p.member_id === me.id)}
                          columns={[
                            { field: "purpose" },
                            {
                              field: "amount",
                              valueFormatter: (p) => money(p.value),
                            },
                            { field: "status" },
                            { field: "batch_id", headerName: "Provider batch" },
                            { field: "item_id", headerName: "Provider item" },
                            { field: "last_error" },
                          ]}
                        />
                      </section>
                      <section className="card">
                        <h2>Your ledger</h2>
                        <button
                          onClick={() =>
                            run(async () => {
                              const v = await api<{
                                valid: boolean;
                                entries: number;
                              }>(`/circles/${data.circle.id}/verify`);
                              setNotice(
                                `${v.valid ? "Verified" : "Failed"} · ${v.entries} ledger entries`,
                              );
                            })
                          }
                        >
                          Verify hash chain
                        </button>
                        <Grid<Ledger>
                          name="ledger"
                          rows={data.ledger.filter((l) => l.member_id === me.id)}
                          columns={[
                            { field: "seq" },
                            { field: "kind" },
                            {
                              field: "amount",
                              valueFormatter: (p) => money(p.value),
                            },
                            { field: "memo", minWidth: 320 },
                            { field: "hash" },
                          ]}
                        />
                      </section>
                    </>
                  )}
                  {depositProposal && depositProposal.member_id === me.id && (
                    <section className="card" aria-label="Confirm deposit">
                      <h2>Confirm your deposit</h2>
                      <p>
                        Transfer {money(depositProposal.amount)} from your account to the
                        circle Treasurer as collateral.
                      </p>
                      <p>
                        {config?.demo
                          ? "This is a simulated transfer."
                          : "The PayPal agent will open checkout. Approve with your own PayPal account; the agent captures the approved payment on return."}
                      </p>
                      <label>
                        Type okay to confirm this amount
                        <input
                          value={depositConfirmation}
                          onChange={(event) => setDepositConfirmation(event.target.value)}
                          autoComplete="off"
                        />
                      </label>
                      <button
                        className="primary"
                        disabled={
                          busy || depositConfirmation.trim().toLowerCase() !== "okay"
                        }
                        onClick={() =>
                          run(async () => {
                            const result = await api<{
                              status: string;
                              approval_url?: string;
                            }>(`/members/${me.id}/deposit-confirmation`, {
                              order_id: depositProposal.id,
                              confirmation: depositConfirmation,
                            });
                            if (result.approval_url) location.assign(result.approval_url);
                            else if (result.status === "completed") {
                              setDepositProposal(null);
                              setNotice(
                                config?.demo
                                  ? "Simulated deposit received by Treasurer."
                                  : "Deposit confirmed.",
                              );
                            } else throw new Error("PayPal approval is still required");
                          })
                        }
                      >
                        Okay, deposit {money(depositProposal.amount)}
                      </button>
                      <button disabled={busy} onClick={() => setDepositProposal(null)}>
                        Cancel
                      </button>
                    </section>
                  )}
                  {(data.circle.rules_json.request_window_seconds ||
                    data.circle.mode === "auction") &&
                    data.circle.status === "active" && (
                      <section className="card">
                        <h2>Request this round’s payout</h2>
                        <p>
                          {cycle?.request_closes_at
                            ? `Request window: ${Math.max(0, Math.ceil((new Date(cycle.request_closes_at).getTime() - now) / 1000))} seconds remaining.`
                            : "The request window opens when the entire pot is funded."}
                        </p>
                        <p>
                          Request with zero discount, or offer to accept less. Highest
                          discount wins; earliest bid breaks ties. The discount goes
                          equally to all other members, with any leftover cents assigned
                          in rotation order. No requests: next eligible rotation member
                          wins.
                        </p>
                        {me.has_won ? (
                          <p role="status">
                            You already received a pot in this circle and cannot claim
                            again.
                          </p>
                        ) : (
                          <>
                            <label>
                              Discount offered ({data.circle.currency})
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={bid}
                                onChange={(event) => setBid(event.target.value)}
                              />
                            </label>
                            <button
                              disabled={
                                busy ||
                                (Boolean(data.circle.rules_json.request_window_seconds) &&
                                  (!cycle?.request_closes_at ||
                                    now >= new Date(cycle.request_closes_at).getTime()))
                              }
                              onClick={() =>
                                run(async () => {
                                  await api(`/members/${me.id}/bid`, {
                                    discount: Math.round(Number(bid) * 100),
                                  });
                                  setNotice(
                                    "Payout request saved. You can update your discount until the window closes.",
                                  );
                                })
                              }
                            >
                              Request payout / update discount
                            </button>
                          </>
                        )}
                        <Grid
                          name="Payout requests"
                          rows={(cycle?.bids || []).map((entry) => ({
                            ...entry,
                            name: data.members.find(
                              (member) => member.id === entry.member_id,
                            )?.name,
                            discount: Number(entry.discount),
                          }))}
                          columns={[
                            { field: "name", headerName: "Member" },
                            {
                              field: "discount",
                              valueFormatter: (params) => money(params.value),
                            },
                          ]}
                        />
                      </section>
                    )}
                  {tab === "Treasurer" && (
                    <section className="card">
                      <span className="eyebrow">
                        AUTONOMOUS ACTIVITY · NO CHAT REQUIRED
                      </span>
                      <h2>Why each transfer happens</h2>
                      <p>
                        The engine validates the winner, funded pot, collateral deductions
                        and retention.{" "}
                        {config?.ai
                          ? "Your configured model automatically explains approved decisions."
                          : "Rule-based decision explanations remain available without an LLM."}{" "}
                        A payout intent is not proof of PayPal delivery: check transaction
                        status.
                      </p>
                      {data.decisions.length ? (
                        data.decisions.map((d) => (
                          <article className="activity-item" key={d.id}>
                            <span>✧</span>
                            <div>
                              <small>
                                {d.tool === "cycle_decision"
                                  ? "POLICY-APPROVED PAYOUT"
                                  : d.result.source === "openai"
                                    ? "AI EXPLANATION"
                                    : "POLICY EXPLANATION"}{" "}
                                · {new Date(d.created_at).toLocaleTimeString()}
                              </small>
                              {d.result.winner && (
                                <h2>
                                  {
                                    data.members.find((m) => m.id === d.result.winner)
                                      ?.name
                                  }{" "}
                                  · {money(d.result.payout)}
                                </h2>
                              )}
                              <p>{d.result.explanation || d.result.reason}</p>
                            </div>
                          </article>
                        ))
                      ) : (
                        <p>
                          No payout decisions yet. Deposit all collateral to activate the
                          circle.
                        </p>
                      )}
                    </section>
                  )}
                  {tab === "Members" && (
                    <section className="card">
                      <h2>Your settlement</h2>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () =>
                            setSettlement(await api(`/members/${me.id}/settlement`)),
                          )
                        }
                      >
                        Preview exit
                      </button>
                      {settlement && (
                        <>
                          <pre className="answer">
                            {JSON.stringify(settlement, null, 2)}
                          </pre>
                          <p>Early exit pauses the circle for reconciliation.</p>
                          <button
                            disabled={busy || me.status === "exited"}
                            onClick={() => run(() => api(`/members/${me.id}/exit`, {}))}
                          >
                            Confirm exit and refund
                          </button>
                        </>
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}
          <footer>
            <span>◉ TrustCircle</span>
            <p>PayPal Agent Toolkit · AG Grid</p>
            <small>
              Sandbox prototype. Collateral reduces risk; it does not eliminate it.
            </small>
          </footer>
        </div>
      </main>
      {busy && <div className="working">Processing…</div>}
    </div>
  );
}

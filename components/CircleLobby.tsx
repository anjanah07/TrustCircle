"use client";
import { useEffect, useState } from "react";
import Grid from "./Grid";
type Circle = {
  id: string;
  name: string;
  contribution: string;
  n_members: number;
  currency: string;
  collateral_amount: string;
  min_trust_score: number;
  joined: number;
  status?: string;
  visibility?: string;
};
async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-circle-invite": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Request failed");
  return result;
}
export default function CircleLobby({
  onOpen,
}: {
  onOpen: (id: string) => Promise<void>;
}) {
  const [mine, setMine] = useState<Circle[]>([]),
    [publicCircles, setPublic] = useState<Circle[]>([]);
  const [score, setScore] = useState(0),
    [currency, setCurrency] = useState("USD");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(""),
    [preview, setPreview] = useState<Circle | null>(null),
    [inviteToken, setToken] = useState("");
  const [form, setForm] = useState({
    name: "Builders Circle",
    payout: "2500",
    members: "5",
    collateral: "1500",
    visibility: "private",
    minimum: "50",
  });
  const total = Math.round(Number(form.payout) * 100),
    seats = Number(form.members),
    contribution = total / seats;
  const money = (amount: number, code = currency) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
      amount / 100,
    );
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [own, available, account, config] = await Promise.all([
      api<Circle[]>("/circles"),
      api<Circle[]>("/circles/public"),
      api<{ trust_score: number }>("/me"),
      api<{ currency: string }>("/config"),
    ]);
    setMine(own);
    setPublic(available);
    setScore(account.trust_score);
    setCurrency(config.currency);
  }
  async function previewInvite(value: string) {
    const url = new URL(value, window.location.origin);
    const match = url.pathname.match(/^\/invite\/([a-f0-9-]{36})$/i);
    if (!match) throw Error("Paste a complete TrustCircle invite link");
    const token = url.searchParams.get("token") || "";
    const circle = await api<Circle>(`/circles/${match[1]}/preview`, undefined, token);
    setToken(token);
    setPreview(circle);
  }
  useEffect(() => {
    void run(async () => {
      await refresh();
      if (window.location.pathname.startsWith("/invite/")) {
        setInvite(window.location.href);
        await previewInvite(window.location.href);
      }
    });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      void api<Circle[]>("/circles/public")
        .then(setPublic)
        .catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, []);
  async function join(circle: Circle, token?: string) {
    await api(`/circles/${circle.id}/join`, { invite_token: token });
    await onOpen(circle.id);
  }
  return (
    <>
      <section className="welcome">
        <span className="eyebrow">A CIRCLE ON YOUR TERMS</span>
        <h1>
          Choose your people.
          <br />
          Set your pace.
        </h1>
        <p>
          Your trust score: <b>{score}/100</b>. Public circles use this payment-history
          score for entry.
        </p>
        <a className="primary" href="/demo">
          Experience before you invest ↗
        </a>
      </section>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {mine.length > 0 && (
        <section className="card">
          <h2>Your circles</h2>
          <div className="demo-actions">
            {mine.map((circle) => (
              <button
                key={circle.id}
                disabled={busy}
                onClick={() => run(() => onOpen(circle.id))}
              >
                {circle.name} · {circle.status}
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="card">
        <h2>Open a private invite</h2>
        <label>
          Circle invite link
          <input
            value={invite}
            placeholder="https://your-app/invite/…?token=…"
            onChange={(event) => {
              const value = event.target.value;
              setInvite(value);
              setPreview(null);
              if (/^https?:\/\//.test(value)) void run(() => previewInvite(value));
            }}
          />
        </label>
        <button
          disabled={busy || !invite}
          onClick={() => run(() => previewInvite(invite))}
        >
          Open group page
        </button>
        {preview && (
          <div className="notice">
            <h3>{preview.name}</h3>
            <p>
              {preview.joined}/{preview.n_members} members ·{" "}
              {money(Number(preview.contribution), preview.currency)} monthly per member ·{" "}
              {money(Number(preview.collateral_amount), preview.currency)} collateral
            </p>
            <p>
              {preview.visibility} · {preview.status}
            </p>
            <button
              className="primary"
              disabled={
                busy ||
                (preview.status !== "forming" && !mine.some((c) => c.id === preview.id))
              }
              onClick={() =>
                run(() =>
                  mine.some((c) => c.id === preview.id)
                    ? onOpen(preview.id)
                    : join(preview, inviteToken),
                )
              }
            >
              {mine.some((c) => c.id === preview.id)
                ? "Open my circle"
                : "Join this circle"}
            </button>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Create a circle</h2>
        <p>
          Hackathon demo timing: 30 seconds to contribute, then 30 seconds of grace. The
          creator can pause and resume the timer. PayPal sandbox approvals are still
          required.
        </p>
        <form
          className="circle-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (!Number.isSafeInteger(contribution))
                throw Error(
                  "Monthly payout must divide equally among members in whole cents",
                );
              const circle = await api<Circle>("/circles", {
                name: form.name,
                monthly_payout: total,
                n_members: seats,
                collateral_amount: Math.round(Number(form.collateral) * 100),
                visibility: form.visibility,
                min_trust_score: Number(form.minimum),
                mode: "auction",
              });
              await onOpen(circle.id);
            });
          }}
        >
          <div className="formgrid">
            <label>
              Circle name
              <input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Monthly payout / total pot ({currency})
              <input
                required
                type="number"
                min="0.01"
                max="1000000"
                step="0.01"
                value={form.payout}
                onChange={(e) => setForm({ ...form, payout: e.target.value })}
              />
            </label>
            <label>
              Number of members
              <input
                required
                type="number"
                min="2"
                max="10"
                step="1"
                value={form.members}
                onChange={(e) => setForm({ ...form, members: e.target.value })}
              />
            </label>
            <label>
              Collateral per member ({currency})
              <input
                required
                type="number"
                min={Math.ceil(contribution) / 100 || 0.01}
                max="1000000"
                step="0.01"
                value={form.collateral}
                onChange={(e) => setForm({ ...form, collateral: e.target.value })}
              />
            </label>
            <label>
              Circle visibility
              <select
                value={form.visibility}
                onChange={(e) => setForm({ ...form, visibility: e.target.value })}
              >
                <option value="private">Private · invite link only</option>
                <option value="public">Public · trust-score entry</option>
              </select>
            </label>
            {form.visibility === "public" && (
              <label>
                Minimum trust score
                <input
                  type="number"
                  required
                  min="50"
                  max="100"
                  step="1"
                  value={form.minimum}
                  onChange={(e) => setForm({ ...form, minimum: e.target.value })}
                />
              </label>
            )}
          </div>
          <p>
            Monthly contribution per member:{" "}
            <b>{Number.isFinite(contribution) ? money(contribution) : "—"}</b>. The total
            pot is before bidding discounts and retained funds. Collateral must cover at
            least one contribution.
          </p>
          <p>
            Two missed payments after grace result in a bar and a paused circle, even if
            collateral remains. Remaining balances are preserved for settlement.
          </p>
          <button className="primary" disabled={busy}>
            Create circle →
          </button>
        </form>
      </section>
      <section className="card">
        <h2>Discover public circles</h2>
        <p>
          Open circles disappear from this list once full. Entry requires the displayed
          trust score.
        </p>
        <Grid<Circle>
          name="Public circles"
          rows={publicCircles}
          columns={[
            { field: "name" },
            {
              field: "n_members",
              headerName: "Seats",
              valueGetter: (p) => `${p.data?.joined}/${p.data?.n_members}`,
            },
            {
              field: "contribution",
              headerName: "Monthly contribution",
              valueFormatter: (p) => money(Number(p.value), p.data?.currency),
            },
            {
              field: "collateral_amount",
              headerName: "Collateral",
              valueFormatter: (p) => money(Number(p.value), p.data?.currency),
            },
            { field: "min_trust_score", headerName: "Required score" },
            {
              headerName: "Join",
              cellRenderer: (p: { data: Circle }) => (
                <button
                  disabled={busy || score < p.data.min_trust_score}
                  onClick={() => run(() => join(p.data))}
                >
                  {score < p.data.min_trust_score ? "Score too low" : "Join circle"}
                </button>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}

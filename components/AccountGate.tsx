"use client";
import { useEffect, useState } from "react";
import Dashboard from "./Dashboard";

type User = { id: string; name: string; username: string };
export default function AccountGate() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  function accept(account: User) {
    if (sessionStorage.getItem("tc-account") !== account.id) {
      sessionStorage.removeItem("tc-next-session");
      sessionStorage.removeItem("tc-dashboard-tab");
    }
    sessionStorage.setItem("tc-account", account.id);
    setUser(account);
  }
  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        if (response.ok) accept(await response.json());
        else if (response.status === 503) setSetup(true);
      })
      .catch(() => setError("Unable to reach the server. Please refresh to retry."))
      .finally(() => setLoading(false));
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(`/api/auth/${signup ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Unable to sign in");
      accept(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }
  if (user) return <Dashboard />;
  if (loading)
    return (
      <main className="entry-shell" aria-busy="true">
        <p role="status">Restoring your session…</p>
      </main>
    );
  return (
    <main className="entry-shell">
      <header className="entry-header">
        <a className="brand" href="/">
          ◉ TrustCircle
        </a>
        <a href="/demo">Explore the demo ↗</a>
      </header>
      <div className="entry-layout">
        <section className="entry-hero">
          <span className="eyebrow">YOUR PEOPLE. YOUR PROGRESS.</span>
          <h1>
            Build trust.
            <br />
            <span>Move together.</span>
          </h1>
          <p>
            A shared savings circle with transparent rules, a dedicated Treasurer, and a
            record of every transfer.
          </p>
          <div className="entry-orbit" aria-hidden="true">
            <div className="entry-orbit-ring" />
            <b>
              ◉<small>TRUSTCIRCLE</small>
            </b>
            {["A", "R", "M", "J", "S"].map((name, i) => (
              <span
                key={name}
                style={{
                  transform: `rotate(${i * 72}deg) translateY(-120px) rotate(${-i * 72}deg)`,
                }}
              >
                {name}
              </span>
            ))}
          </div>
          <a href="/demo" className="experience-card">
            <span className="eyebrow">NO SIGNUP. NO MONEY REQUIRED.</span>
            <h2>Experience before you invest ↗</h2>
            <p>
              Try deposits, switch between five members, bid for a payout, and inspect the
              Treasurer’s decisions.
            </p>
            <small>Interactive simulation • No PayPal transfers</small>
          </a>
        </section>
        <section className="card auth-card">
          <span className="eyebrow">YOUR SECURE CIRCLE</span>
          <h2>{signup ? "Create your account" : "Welcome back"}</h2>
          <p>Sign in to access your PayPal sandbox circles.</p>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {setup ? (
            <p className="notice">
              PayPal setup is in progress. You can explore the public demo while account
              access is being configured.
            </p>
          ) : (
            <form onSubmit={submit}>
              {signup && (
                <>
                  <label>
                    Your name
                    <input name="name" required maxLength={80} autoComplete="name" />
                  </label>
                  <label>
                    PayPal sandbox email
                    <input
                      name="email"
                      type="email"
                      required
                      maxLength={254}
                      autoComplete="email"
                    />
                  </label>
                </>
              )}
              <label>
                Username
                <input
                  name="username"
                  required
                  pattern="[a-zA-Z0-9_]{3,32}"
                  minLength={3}
                  maxLength={32}
                  autoComplete="username"
                  autoCapitalize="none"
                  title="3–32 letters, numbers or underscores"
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete={signup ? "new-password" : "current-password"}
                />
              </label>
              {signup && (
                <>
                  <small>
                    At least 12 characters. Use a separate password from PayPal.
                  </small>
                  <details>
                    <summary>Already have an old member account?</summary>
                    <label>
                      Existing member token
                      <input
                        name="legacyToken"
                        type="password"
                        autoComplete="off"
                        maxLength={128}
                      />
                    </label>
                    <small>
                      Use your saved token once to retain your existing circles.
                    </small>
                  </details>
                </>
              )}
              <button className="primary" disabled={busy || loading}>
                {loading
                  ? "Checking session…"
                  : busy
                    ? "Please wait…"
                    : signup
                      ? "Create account →"
                      : "Log in →"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSignup(!signup);
                  setError("");
                }}
              >
                {signup ? "Already registered? Log in" : "New here? Sign up"}
              </button>
            </form>
          )}
          <p className="auth-footnote">
            PayPal approval is still required for payments. This deployment uses sandbox
            accounts and sandbox funds.
          </p>
        </section>
      </div>
    </main>
  );
}

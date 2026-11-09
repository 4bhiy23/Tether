"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../lib/auth-client";

export function AuthScreen() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;

    try {
      if (submitter?.value === "signup") {
        if (!name.trim()) {
          setError("Enter your name to create an account.");
          return;
        }
        const result = await authClient.signUp.email({ name: name.trim(), email, password });
        if (result.error) setError(result.error.message ?? "Account creation failed.");
        return;
      }

      const result = await authClient.signIn.email({ email, password });
      if (result.error) setError(result.error.message ?? "Sign in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="session-state">
      <section className="auth-shell" aria-labelledby="auth-heading">
        <div className="auth-intro">
          <p className="wordmark">tether.</p>
          <div>
            <h1>Keep the thread, wherever you are.</h1>
            <p>Messages stay ordered across devices, reconnects, and every server in between.</p>
          </div>
        </div>
        <div className="auth-panel">
          <h2 id="auth-heading">Welcome back</h2>
          <p>Sign in, or enter your name to create an account.</p>
          <form className="auth-form" onSubmit={submit}>
            <label className="field">
              Name
              <input
                autoComplete="name"
                placeholder="For a new account"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              Email
              <input
                autoComplete="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="field">
              Password
              <input
                autoComplete="current-password"
                minLength={8}
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button className="button button-primary" disabled={pending} name="action" value="signin">
                Sign in
              </button>
              <button className="button button-secondary" disabled={pending} name="action" value="signup">
                Create account
              </button>
            </div>
            {error ? <p className="error-text" role="alert">{error}</p> : null}
          </form>
        </div>
      </section>
    </main>
  );
}

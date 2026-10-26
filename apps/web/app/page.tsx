"use client";

import { FormEvent, useState } from "react";
import { authClient } from "../lib/auth-client";

export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const result = await authClient.signIn.email({ email, password });
    if (result.error) setError(result.error.message ?? "Unable to sign in");
  }

  async function signUp() {
    setError("");
    const result = await authClient.signUp.email({ name, email, password });
    if (result.error) setError(result.error.message ?? "Unable to sign up");
  }

  if (isPending) return <main>Loading session…</main>;
  if (session) {
    return <main><p>Signed in as {session.user.email}</p><button onClick={() => authClient.signOut()}>Sign out</button></main>;
  }

  return <main><h1>Tether</h1><form onSubmit={submit}><input aria-label="Name" placeholder="Name (for sign up)" value={name} onChange={(event) => setName(event.target.value)} /><input aria-label="Email" type="email" placeholder="Email" required value={email} onChange={(event) => setEmail(event.target.value)} /><input aria-label="Password" type="password" placeholder="Password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button>Sign in</button><button type="button" onClick={signUp}>Sign up</button>{error && <p role="alert">{error}</p>}</form></main>;
}

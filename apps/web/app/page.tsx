"use client";

import { FormEvent, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { connectLiveEvents } from "../lib/live-socket";

export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!session) return;

    let closed = false;
    const liveEvents = connectLiveEvents(session.user.id);
    void liveEvents.then((connection) => {
      if (closed) connection.close();
    }).catch(() => undefined);
    return () => {
      closed = true;
      void liveEvents.then((connection) => connection.close()).catch(() => undefined);
    };
  }, [session?.session.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "signup") {
      if (!name.trim()) return setError("Name is required");
      const result = await authClient.signUp.email({ name: name.trim(), email, password });
      if (result.error) setError(result.error.message ?? "Unable to sign up");
      return;
    }

    const result = await authClient.signIn.email({ email, password });
    if (result.error) setError(result.error.message ?? "Unable to sign in");
  }

  if (isPending) return <main>Loading session…</main>;
  if (session) {
    return <main><p>Signed in as {session.user.email}</p><button onClick={() => authClient.signOut()}>Sign out</button></main>;
  }

  return <main><h1>Tether</h1><form onSubmit={submit}><input aria-label="Name" placeholder="Name (for sign up)" value={name} onChange={(event) => setName(event.target.value)} /><input aria-label="Email" type="email" placeholder="Email" required value={email} onChange={(event) => setEmail(event.target.value)} /><input aria-label="Password" type="password" placeholder="Password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button name="action" value="signin">Sign in</button><button name="action" value="signup">Sign up</button>{error && <p role="alert">{error}</p>}</form></main>;
}

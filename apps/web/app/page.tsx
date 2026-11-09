"use client";

import { authClient } from "../lib/auth-client";
import { AuthScreen } from "./auth-screen";
import { ChatApp } from "./chat-app";

export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <main className="session-state" aria-live="polite">Loading session…</main>;
  if (!session) return <AuthScreen />;
  return <ChatApp account={{ id: session.user.id, name: session.user.name, email: session.user.email }} />;
}

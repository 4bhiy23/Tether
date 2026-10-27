"use client";

import { createAuthClient } from "better-auth/react";

export const chatUrl = process.env.NEXT_PUBLIC_CHAT_URL ?? "http://localhost:4000";

export const authClient = createAuthClient({
  baseURL: chatUrl,
});

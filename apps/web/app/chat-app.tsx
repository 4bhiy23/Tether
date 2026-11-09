"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth-client";
import { createChatClient, type ChatClient } from "../lib/chat-client";
import type {
  Conversation,
  ConversationMember,
  ConversationSummary,
  Message,
  OptimisticMessage,
} from "../lib/chat-types";
import { ChatShell } from "./chat-shell";

type Account = { id: string; name: string; email: string };

export function ChatApp({ account }: { account: Account }) {
  const [client, setClient] = useState<ChatClient>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [error, setError] = useState("");
  const activeId = useRef<string | undefined>(undefined);
  const activeConversationRef = useRef<Conversation | undefined>(undefined);

  const refresh = useCallback(async (target: ChatClient) => {
    const list = await target.getConversationList();
    setConversations(list);
    const conversationId = activeId.current;
    if (!conversationId) return;

    const stored = await target.getConversation(conversationId);
    const current = stored ?? (
      activeConversationRef.current?.id === conversationId
        ? activeConversationRef.current
        : undefined
    );
    activeConversationRef.current = current;
    setActiveConversation(current);
    const localMessages = await target.getMessages(conversationId);
    setMessages(localMessages.confirmed);
    setOptimistic(localMessages.pending);
    setPresence(target.getPresence(conversationId));
    const names = new Map(current?.members.map((member) => [member.id, member.name]) ?? []);
    setTypingNames(
      target.getTyping(conversationId)
        .filter((userId) => userId !== account.id)
        .map((userId) => names.get(userId) ?? "Someone"),
    );
  }, [account.id]);

  const markVisibleRead = useCallback((sequence: number) => {
    const conversationId = activeId.current;
    if (client && conversationId) void client.markRead(conversationId, sequence);
  }, [client]);

  useEffect(() => {
    let closed = false;
    let unsubscribe: () => void = () => {};
    const pending = createChatClient({ userId: account.id });

    void pending.then((connected) => {
      if (closed) return connected.close();
      setClient(connected);
      unsubscribe = connected.subscribe(() => void refresh(connected));
      return refresh(connected);
    }).catch(() => {
      if (!closed) setError("Chat could not connect. Refresh to try again.");
    });

    return () => {
      closed = true;
      unsubscribe();
      void pending.then((connected) => connected.close()).catch(() => undefined);
    };
  }, [account.id, refresh]);

  async function selectConversation(conversation?: Conversation) {
    activeId.current = conversation?.id;
    activeConversationRef.current = conversation;
    setActiveConversation(conversation);
    setMessages([]);
    setOptimistic([]);
    setTypingNames([]);
    setPresence({});
    client?.selectConversation(conversation?.id);
    if (client) await refresh(client);
  }

  async function createConversation(input: {
    kind: "direct" | "group";
    title?: string;
    members: ConversationMember[];
  }) {
    if (!client) throw new Error("Chat is unavailable");
    const conversation = await client.createConversation({
      kind: input.kind,
      title: input.title,
      memberIds: input.members.map(({ id }) => id),
    });
    await selectConversation(conversation);
  }

  async function send(content: string) {
    if (!client || !activeConversation) return;
    await client.sendMessage(activeConversation.id, content).catch(() => undefined);
  }

  async function loadOlder() {
    if (!client || !activeConversation || messages.length === 0) return false;
    const response = await client.loadHistory(activeConversation.id, messages[0].sequence);
    await refresh(client);
    return response.hasMore;
  }

  if (error) {
    return <main className="session-state"><div><p className="error-text" role="alert">{error}</p><button className="button button-secondary" type="button" onClick={() => void authClient.signOut()}>Sign out</button></div></main>;
  }

  if (!client) return <main className="session-state" aria-live="polite">Opening your conversations…</main>;

  return (
    <ChatShell
      account={account}
      activeConversation={activeConversation}
      conversations={conversations}
      messages={messages}
      optimistic={optimistic}
      presence={presence}
      typingNames={typingNames}
      onCreate={createConversation}
      onLoadOlder={loadOlder}
      onLookup={client.lookupUser}
      onRetry={(message) => void client.retryMessage(message.clientMessageId).catch(() => undefined)}
      onSelect={(conversation) => void selectConversation(conversation)}
      onSend={send}
      onSignOut={() => void authClient.signOut()}
      onTyping={(typing) => {
        if (activeConversation) client.setTyping(activeConversation.id, typing);
      }}
      onVisible={markVisibleRead}
    />
  );
}

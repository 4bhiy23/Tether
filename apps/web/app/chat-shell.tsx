"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Conversation,
  ConversationMember,
  ConversationSummary,
  Message,
  OptimisticMessage,
} from "../lib/chat-types";

type Account = { id: string; name: string; email: string };

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0]}` : value.slice(0, 2)).toUpperCase();
}

function conversationName(conversation: Conversation, userId: string) {
  if (conversation.kind === "group") return conversation.title || "Untitled group";
  return conversation.members.find(({ id }) => id !== userId)?.name ?? "Direct message";
}

function messageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function Avatar({ name, group = false, online = false }: { name: string; group?: boolean; online?: boolean }) {
  return (
    <span className={`avatar${group ? " avatar-group" : ""}`} aria-hidden="true">
      {initials(name)}
      {online ? <span className="presence-dot" /> : null}
    </span>
  );
}

function ConversationRail({
  account,
  activeId,
  conversations,
  filter,
  presence,
  onFilter,
  onNew,
  onSelect,
  onSignOut,
}: {
  account: Account;
  activeId?: string;
  conversations: ConversationSummary[];
  filter: string;
  presence: Record<string, boolean>;
  onFilter: (value: string) => void;
  onNew: () => void;
  onSelect: (conversation: Conversation) => void;
  onSignOut: () => void;
}) {
  const visible = conversations.filter(({ conversation }) =>
    conversationName(conversation, account.id).toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <aside className="conversation-rail" aria-label="Conversations">
      <header className="rail-header">
        <div className="rail-heading">
          <p className="wordmark">tether.</p>
          <button className="new-chat-button" type="button" onClick={onNew}>＋ New</button>
        </div>
        <label className="field">
          <span className="sr-only">Find a conversation</span>
          <input
            className="search-input"
            placeholder="Find a conversation"
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
          />
        </label>
      </header>
      <nav className="conversation-list" aria-label="Message threads">
        {visible.map(({ conversation, latestMessage, unreadCount }) => {
          const name = conversationName(conversation, account.id);
          const other = conversation.kind === "direct"
            ? conversation.members.find(({ id }) => id !== account.id)
            : undefined;
          return (
            <button
              className="conversation-row"
              aria-current={activeId === conversation.id}
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation)}
            >
              <Avatar
                group={conversation.kind === "group"}
                name={name}
                online={other ? presence[other.id] : false}
              />
              <span className="conversation-copy">
                <span className="conversation-name">{name}</span>
                <span className="conversation-preview">{latestMessage.senderId === account.id ? "You: " : ""}{latestMessage.content}</span>
              </span>
              {unreadCount > 0 ? <span className="unread-badge" aria-label={`${unreadCount} unread messages`}>{unreadCount}</span> : null}
            </button>
          );
        })}
        {visible.length === 0 ? <p className="rail-empty">{filter ? "No matching conversations." : "Your conversations will appear after the first message."}</p> : null}
      </nav>
      <footer className="account-strip">
        <Avatar name={account.name} />
        <span className="account-copy"><strong>{account.name}</strong><span>{account.email}</span></span>
        <button className="button button-danger" type="button" onClick={onSignOut}>Sign out</button>
      </footer>
    </aside>
  );
}

function ConfirmedMessage({
  message,
  own,
  onVisible,
}: {
  message: Message;
  own: boolean;
  onVisible: (sequence: number) => void;
}) {
  const element = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && document.visibilityState === "visible") onVisible(message.sequence);
    }, { threshold: 0.6 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [message.sequence, onVisible]);

  return (
    <li className={`message-row${own ? " message-row-own" : ""}`} ref={element} data-sequence={message.sequence}>
      <article className="message-bubble">
        <p>{message.content}</p>
        <footer className="message-meta"><time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time></footer>
      </article>
    </li>
  );
}

function OptimisticBubble({ message, onRetry }: { message: OptimisticMessage; onRetry: (message: OptimisticMessage) => void }) {
  return (
    <li className={`message-row message-row-own message-${message.status}`}>
      <article className="message-bubble">
        <p>{message.content}</p>
        <footer className="message-meta">
          <span>{message.status === "sending" ? "Sending…" : "Not sent"}</span>
          {message.status === "failed" ? <button className="retry-button" type="button" onClick={() => onRetry(message)}>Retry</button> : null}
        </footer>
      </article>
    </li>
  );
}

function MessageThread({
  account,
  conversation,
  messages,
  optimistic,
  online,
  typingText,
  onBack,
  onLoadOlder,
  onRetry,
  onSend,
  onTyping,
  onVisible,
}: {
  account: Account;
  conversation: Conversation;
  messages: Message[];
  optimistic: OptimisticMessage[];
  online: boolean;
  typingText: string;
  onBack: () => void;
  onLoadOlder: () => Promise<boolean>;
  onRetry: (message: OptimisticMessage) => void;
  onSend: (content: string) => Promise<void>;
  onTyping: (typing: boolean) => void;
  onVisible: (sequence: number) => void;
}) {
  const [content, setContent] = useState("");
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const followNewest = useRef(true);
  const typingChanged = useRef(onTyping);
  const name = conversationName(conversation, account.id);

  useEffect(() => {
    typingChanged.current = onTyping;
  }, [onTyping]);

  useEffect(() => {
    setContent("");
    setHistoryAvailable(true);
    typingChanged.current(false);
  }, [conversation.id]);

  useEffect(() => {
    followNewest.current = true;
  }, [conversation.id]);

  useEffect(() => {
    const target = scroller.current;
    if (!target || !followNewest.current) return;
    const frame = requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation.id, messages.length, optimistic.length]);

  async function loadOlder() {
    const target = scroller.current;
    const previousHeight = target?.scrollHeight ?? 0;
    const hasMore = await onLoadOlder();
    setHistoryAvailable(hasMore);
    requestAnimationFrame(() => {
      if (target) target.scrollTop += target.scrollHeight - previousHeight;
    });
  }

  async function send() {
    if (!content.trim()) return;
    const value = content;
    followNewest.current = true;
    setContent("");
    onTyping(false);
    await onSend(value);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  const other = conversation.kind === "direct"
    ? conversation.members.find(({ id }) => id !== account.id)
    : undefined;

  return (
    <section className="thread-pane" aria-label={name}>
      <header className="thread-header">
        <div className="thread-identity">
          <button className="mobile-back" aria-label="Back to conversations" type="button" onClick={onBack}>‹</button>
          <Avatar group={conversation.kind === "group"} name={name} online={online} />
          <div><h2>{name}</h2><p className={online ? "online-copy" : undefined}>{other ? (online ? "Online now" : "Offline") : `${conversation.members.length} members`}</p></div>
        </div>
      </header>
      <div
        className="message-scroller"
        ref={scroller}
        onScroll={(event) => {
          const target = event.currentTarget;
          followNewest.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
        }}
      >
        {messages.length && historyAvailable ? <button className="history-button" type="button" onClick={() => void loadOlder()}>Load earlier messages</button> : null}
        <ol className="message-list">
          {messages.map((message) => <ConfirmedMessage key={message.id} message={message} own={message.senderId === account.id} onVisible={onVisible} />)}
          {optimistic.map((message) => <OptimisticBubble key={message.clientMessageId} message={message} onRetry={onRetry} />)}
        </ol>
        <p className="typing-line" aria-live="polite">{typingText}</p>
      </div>
      <footer className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label={`Message ${name}`}
            maxLength={10_000}
            placeholder={`Message ${name}`}
            value={content}
            onBlur={() => onTyping(false)}
            onChange={(event) => {
              setContent(event.target.value);
              onTyping(event.target.value.trim().length > 0);
            }}
            onKeyDown={keyDown}
          />
          <button className="send-button" aria-label="Send message" disabled={!content.trim()} type="button" onClick={() => void send()}>↑</button>
        </div>
        <p className="composer-help">Enter to send. Shift + Enter starts a new line.</p>
      </footer>
    </section>
  );
}

function NewChatDialog({
  currentUserId,
  onClose,
  onCreate,
  onLookup,
}: {
  currentUserId: string;
  onClose: () => void;
  onCreate: (input: { kind: "direct" | "group"; title?: string; members: ConversationMember[] }) => Promise<void>;
  onLookup: (email: string) => Promise<ConversationMember>;
}) {
  const [kind, setKind] = useState<"direct" | "group">("direct");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [members, setMembers] = useState<ConversationMember[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function addEmail() {
    setError("");
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    if (members.some((member) => member.email.toLowerCase() === normalized)) {
      setError("That person is already included.");
      return;
    }
    setPending(true);
    try {
      const member = await onLookup(normalized);
      if (member.id === currentUserId) {
        setError("Choose another person's email address.");
        return;
      }
      setMembers((current) => [...current, member]);
      setEmail("");
    } catch {
      setError("No account uses that exact email address.");
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const requiredMembers = kind === "direct" ? 1 : 2;
    if (members.length !== requiredMembers && kind === "direct") return setError("Choose one person for a direct message.");
    if (members.length < requiredMembers) return setError("Choose at least two people for a group.");
    if (kind === "group" && !title.trim()) return setError("Enter a group name.");
    setPending(true);
    setError("");
    try {
      await onCreate({ kind, title: kind === "group" ? title.trim() : undefined, members });
      onClose();
    } catch {
      setError("The conversation could not be created. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="new-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="new-chat-heading">
        <header className="dialog-header"><h2 id="new-chat-heading">New conversation</h2><button className="dialog-close" aria-label="Close" type="button" onClick={onClose}>×</button></header>
        <div className="mode-switch" aria-label="Conversation type">
          <button aria-pressed={kind === "direct"} type="button" onClick={() => { setKind("direct"); setMembers([]); }}>Direct</button>
          <button aria-pressed={kind === "group"} type="button" onClick={() => { setKind("group"); setMembers([]); }}>Group</button>
        </div>
        <form className="auth-form" onSubmit={submit}>
          {kind === "group" ? <label className="field">Group name<input maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></label> : null}
          <div className="field">
            <label htmlFor="new-chat-email">Exact email address</label>
            <div className="email-entry">
              <input id="new-chat-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addEmail(); } }} />
              <button className="button button-secondary" disabled={pending || !email.trim()} type="button" onClick={() => void addEmail()}>Add</button>
            </div>
          </div>
          {members.length ? <div>{members.map((member) => <div className="resolved-member" key={member.id}><div><strong>{member.name}</strong><span>{member.email}</span></div><button className="button button-danger" type="button" onClick={() => setMembers((current) => current.filter(({ id }) => id !== member.id))}>Remove</button></div>)}</div> : null}
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          <button className="button button-primary" disabled={pending} type="submit">Start conversation</button>
        </form>
      </section>
    </div>
  );
}

export function ChatShell({
  account,
  activeConversation,
  conversations,
  messages,
  optimistic,
  presence,
  typingNames,
  onCreate,
  onLoadOlder,
  onLookup,
  onRetry,
  onSelect,
  onSend,
  onSignOut,
  onTyping,
  onVisible,
}: {
  account: Account;
  activeConversation?: Conversation;
  conversations: ConversationSummary[];
  messages: Message[];
  optimistic: OptimisticMessage[];
  presence: Record<string, boolean>;
  typingNames: string[];
  onCreate: (input: { kind: "direct" | "group"; title?: string; members: ConversationMember[] }) => Promise<void>;
  onLoadOlder: () => Promise<boolean>;
  onLookup: (email: string) => Promise<ConversationMember>;
  onRetry: (message: OptimisticMessage) => void;
  onSelect: (conversation?: Conversation) => void;
  onSend: (content: string) => Promise<void>;
  onSignOut: () => void;
  onTyping: (typing: boolean) => void;
  onVisible: (sequence: number) => void;
}) {
  const [filter, setFilter] = useState("");
  const [newChat, setNewChat] = useState(false);
  const typingText = useMemo(() => {
    if (typingNames.length === 0) return "";
    if (typingNames.length === 1) return `${typingNames[0]} is typing…`;
    if (typingNames.length === 2) return `${typingNames[0]} and ${typingNames[1]} are typing…`;
    return `${typingNames[0]}, ${typingNames[1]}, and others are typing…`;
  }, [typingNames]);
  const directMember = activeConversation?.kind === "direct"
    ? activeConversation.members.find(({ id }) => id !== account.id)
    : undefined;

  return (
    <main className="chat-page">
      <div className="chat-shell" data-mobile-pane={activeConversation ? "thread" : "list"}>
        <ConversationRail
          account={account}
          activeId={activeConversation?.id}
          conversations={conversations}
          filter={filter}
          presence={presence}
          onFilter={setFilter}
          onNew={() => setNewChat(true)}
          onSelect={onSelect}
          onSignOut={onSignOut}
        />
        {activeConversation ? (
          <MessageThread
            account={account}
            conversation={activeConversation}
            messages={messages}
            optimistic={optimistic}
            online={directMember ? Boolean(presence[directMember.id]) : false}
            typingText={typingText}
            onBack={() => onSelect(undefined)}
            onLoadOlder={onLoadOlder}
            onRetry={onRetry}
            onSend={onSend}
            onTyping={onTyping}
            onVisible={onVisible}
          />
        ) : (
          <section className="empty-thread"><div><h2>Choose a conversation</h2><p>Or start a new one with an exact email address. It appears here after the first message.</p></div></section>
        )}
      </div>
      {newChat ? <NewChatDialog currentUserId={account.id} onClose={() => setNewChat(false)} onCreate={onCreate} onLookup={onLookup} /> : null}
    </main>
  );
}

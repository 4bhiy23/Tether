const rememberedIdLimit = 1_000;

function remember(ids: Set<string>, id: string) {
  if (ids.has(id)) return false;

  ids.add(id);
  if (ids.size > rememberedIdLimit) {
    ids.delete(ids.values().next().value!);
  }
  return true;
}

export function createLiveEventConsumer<
  Message extends { id: string },
  AccountEvent extends { id: string; payload: Message },
>(callbacks: {
  onMessage: (message: Message) => void;
  onAccountEvent: (event: AccountEvent) => void;
}) {
  const messageIds = new Set<string>();
  const accountEventIds = new Set<string>();

  function messageCreated(message: Message) {
    if (!remember(messageIds, message.id)) return false;
    callbacks.onMessage(message);
    return true;
  }

  return {
    messageCreated,
    accountEvent(event: AccountEvent) {
      if (!remember(accountEventIds, event.id)) return false;
      callbacks.onAccountEvent(event);
      messageCreated(event.payload);
      return true;
    },
  };
}

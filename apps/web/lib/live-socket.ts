import { createChatClient } from "./chat-client";

export const connectLiveEvents = (userId: string) => createChatClient({ userId });

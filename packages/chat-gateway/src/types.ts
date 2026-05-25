export interface ChatUser {
  id: string;
  name?: string;
}

export interface ChatChannel {
  id: string;
  name?: string;
  type: 'dm' | 'channel' | 'webhook';
}

export interface ChatMessage {
  id: string;
  text: string;
  user: ChatUser;
  channel: ChatChannel;
  threadId?: string;
  timestamp: string;
}

export interface ChatResponse {
  text: string;
  blocks?: unknown[];
  threadId?: string;
}

export interface ChatAdapter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(channelId: string, message: ChatResponse): Promise<void>;
  onMessage(handler: (msg: ChatMessage) => void): void;
}

export interface ActorMapping {
  providerUserId: string;
  provider: string;
  openslackActorId: string;
  roles: string[];
  agentId?: string;
}

export interface GatewayConfig {
  webhookSecret?: string;
  actorMappingPath?: string;
  allowedWorkspaces?: string[];
  readOnlyByDefault: boolean;
}

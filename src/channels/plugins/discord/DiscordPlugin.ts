/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js';
import type { Message as DiscordMessage, TextBasedChannel } from 'discord.js';
import type { BotInfo, IChannelPluginConfig, IUnifiedOutgoingMessage, PluginType } from '../../types';
import { BasePlugin } from '../BasePlugin';
import { convertHtmlToDiscordMarkdown, splitDiscordMessage, toUnifiedIncomingMessage } from './DiscordAdapter';

/**
 * Debounce delay for final response delivery (ms).
 * All intermediate stream edits are buffered; only the last one is sent to Discord
 * after this delay of silence, giving a "final response only" UX.
 */
const EDIT_DEBOUNCE_MS = 1500;

/**
 * Typing indicator refresh interval (ms).
 * Discord's typing indicator expires after ~10s; refresh before it does.
 */
const TYPING_REFRESH_MS = 8000;

/**
 * DiscordPlugin - Discord Bot integration for AionUi Channel system
 *
 * Uses discord.js v14 with Gateway WebSocket.
 * Supports @mention based activation in servers and direct DMs.
 *
 * "Final response only" mode: all intermediate stream edits are debounced;
 * only the last content update is sent to Discord after EDIT_DEBOUNCE_MS of quiet.
 * A typing indicator runs throughout processing to signal activity.
 *
 * Required Discord Developer Portal settings:
 *   - Bot > Privileged Gateway Intents > MESSAGE CONTENT INTENT ✓
 *   - Bot > Privileged Gateway Intents > SERVER MEMBERS INTENT (optional, for display names)
 */
export class DiscordPlugin extends BasePlugin {
  readonly type: PluginType = 'discord';

  private client: Client | null = null;
  private botInfo: BotInfo | null = null;

  /** Users who have interacted with the bot this session */
  private activeUsers: Set<string> = new Set();

  /** chatId → Discord TextBasedChannel (populated on first message received) */
  private channelCache: Map<string, TextBasedChannel> = new Map();

  /** Discord message ID → Discord Message object (for edits) */
  private sentMessages: Map<string, DiscordMessage> = new Map();

  /** msgId → latest text content buffered for debounced edit */
  private editBuffers: Map<string, string> = new Map();

  /** msgId → debounce timer handle */
  private editTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** chatId → typing refresh interval handle */
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  // ==================== Lifecycle ====================

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const token = config.credentials?.token;
    if (!token) {
      throw new Error('Discord bot token is required');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // Privileged intent — must be enabled in Discord Dev Portal
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message], // Required to receive DMs
    });

    this.setupHandlers();
  }

  protected async onStart(): Promise<void> {
    if (!this.client) throw new Error('Discord client not initialized');

    const token = this.config?.credentials?.token;
    if (!token) throw new Error('Discord bot token missing');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord connection timed out after 30s'));
      }, 30000);

      this.client!.once('ready', (readyClient) => {
        clearTimeout(timeout);
        this.botInfo = {
          id: readyClient.user.id,
          username: readyClient.user.username,
          displayName: readyClient.user.username,
        };
        console.log(`[DiscordPlugin] Logged in as @${readyClient.user.username}`);
        resolve();
      });

      this.client!.login(token).catch((err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  protected async onStop(): Promise<void> {
    // Cancel all pending timers / intervals
    for (const timer of this.editTimers.values()) clearTimeout(timer);
    for (const interval of this.typingIntervals.values()) clearInterval(interval);
    this.editTimers.clear();
    this.typingIntervals.clear();
    this.editBuffers.clear();

    await this.client?.destroy();

    this.client = null;
    this.botInfo = null;
    this.activeUsers.clear();
    this.channelCache.clear();
    this.sentMessages.clear();

    console.log('[DiscordPlugin] Stopped and cleaned up');
  }

  // ==================== BasePlugin Interface ====================

  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  getBotInfo(): BotInfo | null {
    return this.botInfo;
  }

  /**
   * Send a message to a Discord channel.
   * Also starts a typing indicator to show the bot is "thinking".
   */
  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    const channel = this.channelCache.get(chatId);
    if (!channel || !('send' in channel)) {
      throw new Error(`[DiscordPlugin] No cached channel for chatId: ${chatId}`);
    }

    const text = this.formatOutgoing(message);
    const chunks = splitDiscordMessage(text);

    let lastMsgId = '';
    let lastMsg: DiscordMessage | null = null;

    for (const chunk of chunks) {
      const sent = await (channel as { send: (text: string) => Promise<DiscordMessage> }).send(chunk);
      lastMsgId = sent.id;
      lastMsg = sent;
    }

    if (lastMsg) {
      this.sentMessages.set(lastMsgId, lastMsg);
    }

    // Start typing indicator — shows "Bot is typing…" while agent processes
    this.startTypingIndicator(chatId, channel);

    return lastMsgId;
  }

  /**
   * Edit an existing Discord message.
   * In "final response only" mode: all calls are buffered and debounced.
   * Only the last content received within EDIT_DEBOUNCE_MS quiet is actually sent to Discord.
   */
  async editMessage(chatId: string, messageId: string, message: IUnifiedOutgoingMessage): Promise<void> {
    const text = this.formatOutgoing(message);

    // Buffer the latest content
    this.editBuffers.set(messageId, text);

    // Reset debounce timer — each new edit call postpones the actual Discord API call
    const existing = this.editTimers.get(messageId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.editTimers.delete(messageId);
      this.stopTypingIndicator(chatId);

      const content = this.editBuffers.get(messageId) ?? '';
      this.editBuffers.delete(messageId);

      const discordMsg = this.sentMessages.get(messageId);
      if (!discordMsg) return;

      const chunks = splitDiscordMessage(content);

      void discordMsg.edit(chunks[0]).catch((err: unknown) => {
        console.warn('[DiscordPlugin] Failed to edit message:', err);
      });

      // Overflow chunks (if response > 2000 chars) sent as follow-up messages
      if (chunks.length > 1) {
        const ch = this.channelCache.get(chatId);
        if (ch && 'send' in ch) {
          for (let i = 1; i < chunks.length; i++) {
            void (ch as { send: (t: string) => Promise<unknown> }).send(chunks[i]).catch(() => {});
          }
        }
      }
    }, EDIT_DEBOUNCE_MS);

    this.editTimers.set(messageId, timer);
  }

  // ==================== Private Helpers ====================

  private setupHandlers(): void {
    if (!this.client) return;

    this.client.on('messageCreate', async (message) => {
      await this.handleMessageCreate(message as DiscordMessage);
    });

    this.client.on('error', (error) => {
      console.error('[DiscordPlugin] Client error:', error);
      this.setError(error.message);
    });
  }

  private async handleMessageCreate(message: DiscordMessage): Promise<void> {
    // Ignore bots and system messages
    if (!message.author || message.author.bot) return;

    // Fetch partial messages (needed for DMs with Partials.Message)
    let fullMessage = message;
    if (message.partial) {
      try {
        fullMessage = (await message.fetch()) as DiscordMessage;
      } catch (err) {
        console.error('[DiscordPlugin] Failed to fetch partial message:', err);
        return;
      }
    }

    const isInDM = fullMessage.channel.type === ChannelType.DM;
    const isMentioned = this.client?.user ? fullMessage.mentions.has(this.client.user) : false;

    // In servers the bot must be @mentioned; in DMs all messages are accepted
    if (!isInDM && !isMentioned) return;

    // Skip if message content is empty after stripping mentions
    const strippedContent = fullMessage.content.replace(/<@!?\d+>/g, '').trim();
    if (!strippedContent) return;

    const userId = fullMessage.author.id;
    this.activeUsers.add(userId);

    // Build a stable chatId: DMs use the DM channel ID; servers use guild+channel
    const chatId = isInDM ? `dm:${fullMessage.channelId}` : `guild:${fullMessage.guildId}:${fullMessage.channelId}`;

    // Cache the channel object BEFORE emitting the message
    // (sendMessage will need it synchronously after ActionExecutor processes the message)
    this.channelCache.set(chatId, fullMessage.channel);

    const botId = this.client?.user?.id ?? '';
    const unifiedMessage = toUnifiedIncomingMessage(fullMessage, chatId, botId);
    if (!unifiedMessage) return;

    if (this.messageHandler) {
      void this.messageHandler(unifiedMessage).catch((err) => {
        console.error('[DiscordPlugin] Message handler error:', err);
      });
    }
  }

  /**
   * Start / refresh the Discord typing indicator for a channel.
   * The indicator auto-expires after ~10s; we refresh every TYPING_REFRESH_MS.
   */
  private startTypingIndicator(chatId: string, channel: TextBasedChannel): void {
    this.stopTypingIndicator(chatId); // Clear any existing interval

    const sendTyping = () => {
      if ('sendTyping' in channel) {
        void (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
      }
    };

    sendTyping(); // Immediate first send
    const interval = setInterval(sendTyping, TYPING_REFRESH_MS);
    this.typingIntervals.set(chatId, interval);
  }

  private stopTypingIndicator(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  /**
   * Format an IUnifiedOutgoingMessage to plain text for Discord.
   * Converts HTML formatting to Discord markdown.
   */
  private formatOutgoing(message: IUnifiedOutgoingMessage): string {
    const raw = message.text ?? '';
    if (!raw) return '';
    // Convert HTML tags to Discord markdown
    return convertHtmlToDiscordMarkdown(raw);
  }

  // ==================== Static Test Connection ====================

  /**
   * Validate a bot token by logging in and immediately destroying the client.
   * Used by the Settings UI "Test" button.
   */
  static async testConnection(token: string): Promise<{ success: boolean; botInfo?: BotInfo; error?: string }> {
    const testClient = new Client({ intents: [GatewayIntentBits.Guilds] });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timed out (30s)'));
        }, 30000);

        testClient.once('ready', () => {
          clearTimeout(timeout);
          resolve();
        });

        testClient.login(token).catch((err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const botInfo: BotInfo = {
        id: testClient.user!.id,
        username: testClient.user!.username,
        displayName: testClient.user!.username,
      };

      await testClient.destroy();
      return { success: true, botInfo };
    } catch (error: unknown) {
      await testClient.destroy().catch(() => {});
      const msg = error instanceof Error ? error.message : String(error);

      // Provide friendlier messages for common Discord error codes
      const friendlyMsg = msg.includes('TOKEN_INVALID') ? 'Invalid bot token' : msg;
      return { success: false, error: friendlyMsg };
    }
  }
}

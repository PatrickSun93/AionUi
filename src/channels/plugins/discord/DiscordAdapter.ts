/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message as DiscordMessage } from 'discord.js';
import type { IUnifiedIncomingMessage, IUnifiedUser } from '../../types';

/**
 * Discord message character limit
 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Convert a Discord Message to IUnifiedIncomingMessage.
 * Strips all @mention tokens from the content so the agent receives clean text.
 */
export function toUnifiedIncomingMessage(
  message: DiscordMessage,
  chatId: string,
  _botId: string
): IUnifiedIncomingMessage | null {
  const user = toUnifiedUser(message);
  if (!user) return null;

  // Strip @mentions (both <@ID> and <@!ID> forms) and trim
  const rawContent = message.content.replace(/<@!?\d+>/g, '').trim();

  return {
    id: message.id,
    platform: 'discord',
    chatId,
    user,
    content: {
      type: 'text',
      text: rawContent,
    },
    timestamp: message.createdTimestamp,
    raw: message,
  };
}

/**
 * Convert a Discord Message author to IUnifiedUser
 */
export function toUnifiedUser(message: DiscordMessage): IUnifiedUser | null {
  const author = message.author;
  if (!author) return null;

  const displayName = message.member?.displayName || author.displayName || author.username || `User ${author.id}`;

  return {
    id: author.id,
    username: author.username,
    displayName,
  };
}

/**
 * Split a long text into chunks that fit Discord's message limit.
 * Prefers splitting at newlines, then spaces.
 */
export function splitDiscordMessage(text: string, maxLength = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;
    const searchStart = Math.floor(maxLength * 0.8);

    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > searchStart) {
      splitIndex = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(' ', maxLength);
      if (lastSpace > searchStart) splitIndex = lastSpace + 1;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks;
}

/**
 * Convert HTML-formatted agent output to Discord markdown.
 * Discord renders its own markdown: **bold**, *italic*, `code`, ```block```, ~~strike~~
 */
export function convertHtmlToDiscordMarkdown(html: string): string {
  if (!html) return '';

  let result = html;

  // Code blocks first (before inline code) to avoid double-processing
  result = result.replace(/<pre><code(?:\s[^>]*)?>([\s\S]*?)<\/code><\/pre>/g, (_match, code: string) => {
    return `\`\`\`\n${decodeHtmlEntities(code.trim())}\n\`\`\``;
  });

  // Bold
  result = result.replace(/<b>([\s\S]*?)<\/b>/g, '**$1**');
  result = result.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');

  // Italic
  result = result.replace(/<i>([\s\S]*?)<\/i>/g, '*$1*');
  result = result.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');

  // Inline code
  result = result.replace(/<code>([\s\S]*?)<\/code>/g, (_match, code: string) => {
    return `\`${decodeHtmlEntities(code)}\``;
  });

  // Strikethrough
  result = result.replace(/<s>([\s\S]*?)<\/s>/g, '~~$1~~');
  result = result.replace(/<del>([\s\S]*?)<\/del>/g, '~~$1~~');

  // Line breaks
  result = result.replace(/<br\s*\/?>/gi, '\n');

  // Paragraphs
  result = result.replace(/<\/p>/gi, '\n\n');
  result = result.replace(/<p[^>]*>/gi, '');

  // Strip remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Decode remaining HTML entities
  result = decodeHtmlEntities(result);

  // Normalize excessive newlines
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

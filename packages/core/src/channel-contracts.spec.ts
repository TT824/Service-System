import { describe, expect, it } from 'vitest';
import {
  CHANNEL_PROVIDER_NONE,
  channelMessagePlaceholder,
  createUnifiedMessage,
  isChannelMessagePlaceholder,
  type ChannelAdapter,
} from './channel-contracts';

describe('channel contracts', () => {
  it('creates a provider-neutral inbound message', () => {
    const message = createUnifiedMessage({
      channel: 'wecom',
      externalEventId: 'event-1',
      tenantId: 'tenant-1',
      storeId: 'store-1',
      externalCustomerId: 'customer-1',
      externalConversationId: 'conversation-1',
      externalMessageId: 'message-1',
      direction: 'inbound',
      messageType: 'text',
      content: '请问黑色有 XL 吗？',
      dedupKey: 'wecom:message-1',
    });

    expect(message).toMatchObject({
      channel: 'wecom',
      tenantId: 'tenant-1',
      storeId: 'store-1',
      messageType: 'text',
      content: '请问黑色有 XL 吗？',
    });
    expect(message.receivedAt).toEqual(expect.any(String));
  });

  it('keeps the disabled provider explicit', () => {
    const adapter: ChannelAdapter = {
      channel: CHANNEL_PROVIDER_NONE,
      capabilities: {
        receiveText: false,
        receiveImage: false,
        sendText: false,
        sendImage: false,
        sendLink: false,
      },
      verifyWebhook: async () => ({ ok: false, code: 'channel_disabled' }),
      parseInboundMessage: async () => ({ ok: false, code: 'channel_disabled' }),
      syncMessages: async () => ({ ok: false, code: 'channel_disabled' }),
      sendMessage: async () => ({ ok: false, code: 'channel_disabled' }),
      fetchMedia: async () => ({ ok: false, code: 'channel_disabled' }),
      uploadMedia: async () => ({ ok: false, code: 'channel_disabled' }),
    };

    expect(adapter.channel).toBe('none');
    expect(adapter.capabilities.sendText).toBe(false);
  });

  it('provides stable readable placeholders for non-text messages', () => {
    expect(channelMessagePlaceholder('image')).toBe('[图片消息]');
    expect(channelMessagePlaceholder('link')).toBe('[链接消息]');
  });

  it('names a provider message type the platform has no type for', () => {
    // A voice note is stored as *text* — the enum and the column's CHECK are not
    // extended — so this string is all that says it was not typed.
    expect(channelMessagePlaceholder('voice')).toBe('[语音消息]');
    expect(channelMessagePlaceholder('file')).toBe('[文件消息]');
  });

  it('does not put a provider token in front of an operator', () => {
    // The fallback is a name the platform chose, not the field value that
    // happened to arrive: `[新消息类型]` would be a provider's vocabulary
    // leaking into a transcript an operator reads as fact.
    expect(channelMessagePlaceholder('brand_new_type')).toBe('[非文本消息]');
  });

  it('recognises its own placeholders by content, and only those', () => {
    expect(isChannelMessagePlaceholder('[语音消息]')).toBe(true);
    expect(isChannelMessagePlaceholder('[图片消息]')).toBe(true);
    // Trailing whitespace is not a different message.
    expect(isChannelMessagePlaceholder(' [语音消息] ')).toBe(true);

    // The two ways this has to be false, for the two callers that ask: a
    // customer who really typed the words must still get an answer, and a
    // bracket-only sentence is not a placeholder just for being bracketed.
    expect(isChannelMessagePlaceholder('请问什么时候发货？')).toBe(false);
    expect(isChannelMessagePlaceholder('[发货时间]')).toBe(false);
    expect(isChannelMessagePlaceholder('')).toBe(false);
  });
});

import { timingSafeEqual, createHmac } from 'node:crypto';
import type { OpenBotGateway } from './gateway.js';

/** Adapters are opt-in. The daemon never starts network listeners for external channels. */
export class TelegramAdapter {
  constructor(private readonly gateway: OpenBotGateway, private readonly token: string, private readonly allowedChatIds: ReadonlySet<string>) {
    if (!token || !allowedChatIds.size) throw new Error('Telegram requires a bot token and explicit allowed chat IDs');
  }
  async receive(update: unknown): Promise<void> {
    const message = (update as { message?: { text?: unknown; chat?: { id?: unknown } } } | null)?.message;
    const chatId = String(message?.chat?.id ?? '');
    if (!this.allowedChatIds.has(chatId)) throw new Error('Telegram chat is not allowed');
    if (typeof message?.text !== 'string') return;
    const result = await this.gateway.respond(message.text);
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: result.output.slice(0, 4000) })
    });
    if (!response.ok) throw new Error(`Telegram delivery failed (${response.status})`);
  }
}
export class WhatsAppAdapter {
  constructor(private readonly gateway: OpenBotGateway, private readonly phoneId: string, private readonly token: string, private readonly allowedSenders: ReadonlySet<string>, private readonly apiVersion = 'v23.0') {
    if (!/^\d+$/.test(phoneId) || !token || !allowedSenders.size || !/^v\d+\.\d+$/.test(apiVersion)) throw new Error('WhatsApp requires configured phone ID, token, API version, and sender allowlist');
  }
  async receive(sender: string, text: string): Promise<void> {
    if (!this.allowedSenders.has(sender)) throw new Error('WhatsApp sender is not allowed');
    const result = await this.gateway.respond(text);
    const response = await fetch(`https://graph.facebook.com/${this.apiVersion}/${this.phoneId}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: result.output.slice(0, 4000) } })
    });
    if (!response.ok) throw new Error(`WhatsApp delivery failed (${response.status})`);
  }
}
/** Check raw webhook body before JSON parsing. Route replay protection belongs to the caller's durable delivery store. */
export function verifyWebhook(body: Buffer, signature: string, secret: string): boolean {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

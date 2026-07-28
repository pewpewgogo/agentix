/**
 * InvoiceNotifier adapters: webhook POST (default) and a Telegram
 * sendMessage variant. Both run under the port's declared timeout — the
 * runtime aborts the handler's `signal` after `timeoutMs` (5 s), which
 * cancels the in-flight fetch — and both THROW on non-delivery so a failed
 * notification is a visible EFFECT_FAILURE (reported by the observer via
 * the invoice.paid subscriber), never a silent drop.
 */
import type { BoundPortAdapter } from "@agentixdev/core";

import { InvoiceNotifier, type InvoicePaidPayload } from "../features/invoices.js";

export interface WebhookNotifierOptions {
  /** Target URL; receives {"type":"invoice.paid", ...payload} as JSON. */
  readonly url: string;
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export const createWebhookNotifier = (
  options: WebhookNotifierOptions,
): BoundPortAdapter => {
  const fetchImpl = options.fetchImpl ?? fetch;
  return InvoiceNotifier.adapter({
    send: async (notification: InvoicePaidPayload, { signal }) => {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "invoice.paid", ...notification }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`invoice.paid webhook answered ${response.status}`);
      }
      return { delivered: true };
    },
  });
};

export interface TelegramNotifierOptions {
  readonly botToken: string;
  readonly chatId: string;
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Telegram Bot API sendMessage: https://core.telegram.org/bots/api#sendmessage */
export const createTelegramNotifier = (
  options: TelegramNotifierOptions,
): BoundPortAdapter => {
  const fetchImpl = options.fetchImpl ?? fetch;
  return InvoiceNotifier.adapter({
    send: async (notification: InvoicePaidPayload, { signal }) => {
      const text =
        `Invoice ${notification.invoiceId} paid: received ` +
        `${notification.transferAmountNano} nanoTON ` +
        `(invoiced ${notification.amountNano}, tx ${notification.txHash}, ` +
        `comment "${notification.comment}", at ${notification.paidAt})`;
      const response = await fetchImpl(
        `https://api.telegram.org/bot${options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: options.chatId, text }),
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`telegram sendMessage answered ${response.status}`);
      }
      const body = (await response.json().catch(() => undefined)) as
        | { ok?: boolean }
        | undefined;
      if (body?.ok !== true) {
        throw new Error("telegram sendMessage answered ok: false");
      }
      return { delivered: true };
    },
  });
};

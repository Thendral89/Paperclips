// src/lib/whatsapp.js
// Zero-cost default: click-to-WhatsApp. This does not send automatically;
// it opens WhatsApp with the quote URL prefilled and the staff member taps Send.
//
// Keep this as the default even if Cloud API is added later: it has no BSP fee,
// no token management, no webhook, and no Meta API dependency.

export function buildWhatsAppQuoteLink(phone, quoteUrl, clientName = "") {
  const digits = String(phone || "").replace(/\D/g, "");
  const normalized = digits.length === 10 ? `91${digits}` : digits;
  if (!normalized) return null;

  const message =
    `Hi${clientName ? ` ${clientName}` : ""}, this is Paperclip Studios. ` +
    `Your quotation is ready: ${quoteUrl}`;

  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

import { env } from '../../config/env.js';
import { type ObjectIdLike } from '../../types/common.js';

/** Existing trusted owner handler calls Python; no billing decisions or credentials live here. */
export const forwardOwnerPaymentReply = async (
  { organizationId, text }: { organizationId: ObjectIdLike; text: string },
  { fetchFn = fetch, config = env } = {},
): Promise<boolean> => {
  const key = config.WHATSAPP_GATEWAY_SERVICE_KEY || config.AI_BRAIN_SERVICE_KEY;
  if (!key) throw new Error('PAYMENT_GATEWAY_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const base = config.CRM_API_URL || 'http://127.0.0.1:5002';
    const response = await fetchFn(base.replace(/\/$/, '') + '/internal/v1/payments/owner-reply', {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
      body: JSON.stringify({ organizationId: String(organizationId), text }),
    });
    if (!response.ok) throw new Error('PAYMENT_GATEWAY_UNAVAILABLE');
    const result = await response.json() as { data?: { handled?: boolean } };
    if (result.data?.handled !== true) throw new Error('PAYMENT_GATEWAY_NOT_HANDLED');
    return true;
  } finally { clearTimeout(timer); }
};

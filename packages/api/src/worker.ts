import { handleRequest } from './app.ts';
import { handleEmail, type InboundEmail } from './courrier.ts';
import { fromD1, type D1Database } from './d1.ts';

/**
 * Liaisons du Worker, déclarées dans wrangler.toml ; `API_KEYS` et `INTAKE_KEYS` sont des secrets Cloudflare.
 * `MAIL_NETWORK_ID`, `MAIL_FORWARD_TO` et `MAIL_OWN_ADDRESSES` servent à la réception des mails (C06).
 */
export interface Env {
  DB: D1Database;
  API_KEYS?: string;
  INTAKE_KEYS?: string;
  MODE?: string;
  MAIL_NETWORK_ID?: string;
  MAIL_FORWARD_TO?: string;
  MAIL_OWN_ADDRESSES?: string;
  /** Notifications de Meta (C07) : `META_APP_SECRET` et `META_VERIFY_TOKEN_SHA256` sont des secrets. */
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN_SHA256?: string;
  META_NETWORK_ID?: string;
  META_OWN_IDS?: string;
  META_APP_IDS?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      db: fromD1(env.DB),
      apiKeys: env.API_KEYS,
      intakeKeys: env.INTAKE_KEYS,
      mode: env.MODE,
      meta: {
        appSecret: env.META_APP_SECRET,
        verifyTokenSha256: env.META_VERIFY_TOKEN_SHA256,
        networkId: env.META_NETWORK_ID,
        ownIds: env.META_OWN_IDS,
        appIds: env.META_APP_IDS,
      },
    });
  },
  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleEmail(message, {
      db: fromD1(env.DB),
      mode: env.MODE,
      networkId: env.MAIL_NETWORK_ID,
      forwardTo: env.MAIL_FORWARD_TO,
      ownAddresses: env.MAIL_OWN_ADDRESSES,
    });
  },
};

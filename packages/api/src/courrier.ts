/**
 * La réception des mails par le routage mail de Cloudflare (C06), de bout en bout jusqu'à la réponse, en mode
 * essai : la réponse est prête et écrite au journal, jamais envoyée. Mails de portails compris.
 *
 * Le courrier reçu est d'abord remis tel quel à la boîte de l'agent (`MAIL_FORWARD_TO`), pour qu'aucun mail ne
 * se perde : c'est la remise du courrier à son destinataire, pas un message écrit à quelqu'un. Rien n'est jamais
 * rejeté : un rejet écrirait à l'expéditeur.
 */
import { SqlJournalStore, createCaptation, type ChainResult, type SqlDatabase } from '@aimmo/core';
import { TRIAL_MODE, journalError } from './app.ts';
import { MAX_MAIL_BYTES, parseRawMail } from './mail.ts';

/** Ce qu'il faut du message remis par Cloudflare, décrit ici pour ne pas dépendre de ses types. */
export interface InboundEmail {
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  forward(to: string): Promise<unknown>;
}

export interface MailConfig {
  db: SqlDatabase;
  mode: string | undefined;
  /** Réseau auquel appartient l'adresse qui reçoit. */
  networkId: string | undefined;
  /** Boîte où le courrier est remis tel quel. */
  forwardTo: string | undefined;
  /** Nos propres adresses, séparées par des virgules : ce qu'elles écrivent n'est pas un message reçu. */
  ownAddresses: string | undefined;
  now?: () => Date;
}

/** Lit le mail brut ; au-delà de la limite, seul le début est gardé : les en-têtes suffisent. */
async function readRaw(message: InboundEmail): Promise<{ bytes: Uint8Array; size: number }> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (kept <= MAX_MAIL_BYTES) {
      chunks.push(value);
      kept += value.length;
    }
    size += value.length;
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, size };
}

export async function handleEmail(message: InboundEmail, config: MailConfig): Promise<ChainResult[]> {
  const now = config.now ?? (() => new Date());
  if (config.forwardTo) {
    try {
      await message.forward(config.forwardTo);
    } catch {
      // Le détail peut porter une adresse : il ne va nulle part.
      console.error('aimmo-api : remise du mail à la boîte de l’agent impossible');
    }
  }
  if (config.mode !== TRIAL_MODE || !config.networkId) return [];
  const journal = new SqlJournalStore(config.db);
  try {
    const { bytes, size } = await readRaw(message);
    const parsed = parseRawMail(bytes, size);
    const ownIds = (config.ownAddresses ?? '').split(',').map((a) => a.trim()).filter((a) => a !== '');
    const { chaine } = createCaptation(config.db, journal, { now });
    return await chaine.receive(config.networkId, 'email', parsed, { ownIds });
  } catch (error) {
    await journalError(journal, 'mail:routage', 'captation.mail', error, now);
    return [];
  }
}

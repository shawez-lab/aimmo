/**
 * La réception des mails par le routage mail de Cloudflare (C06), de bout en bout jusqu'à la réponse, en mode
 * essai : la réponse est prête et écrite au journal, jamais envoyée. Mails de portails compris.
 *
 * Le courrier reçu est d'abord remis tel quel à la boîte de l'agent (`MAIL_FORWARD_TO`), pour qu'aucun mail ne
 * se perde. Ce n'est pas un envoi au sens du contrôle central : aucun texte n'est composé, l'adresse est fixée par
 * la configuration et vérifiée chez Cloudflare, jamais tirée du mail, et aucun client ne reçoit rien. Rien n'est
 * jamais rejeté : un rejet écrirait à l'expéditeur. `MAIL_FORWARD_TO` ne doit jamais être une adresse elle-même
 * routée vers ce Worker, sinon le mail tournerait en boucle.
 */
import { SqlJournalStore, appendEvent, createCaptation, type ChainResult, type SqlDatabase } from '@aimmo/core';
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
  const journal = new SqlJournalStore(config.db);
  // Une trace au journal pour chaque mail qui n'est pas traité ou pas remis : aucun ne disparaît sans trace.
  // Ni adresse ni détail d'erreur : seulement la raison [R13].
  const note = async (type: 'mail.remise_impossible' | 'mail.non_traite', reason: string): Promise<void> => {
    try {
      await appendEvent(journal, { type, actor: 'mail:routage', subject: null, data: { reason } }, now);
    } catch {
      console.error('aimmo-api : mail sans journal', type, reason);
    }
  };
  if (config.forwardTo) {
    try {
      await message.forward(config.forwardTo);
    } catch {
      await note('mail.remise_impossible', 'remise');
    }
  } else {
    await note('mail.non_traite', 'remise_absente');
  }
  if (config.mode !== TRIAL_MODE) {
    await note('mail.non_traite', 'mode');
    return [];
  }
  if (!config.networkId) {
    await note('mail.non_traite', 'reseau');
    return [];
  }
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

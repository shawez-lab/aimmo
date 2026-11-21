/**
 * L'état de la captation par mail (AU032) : ce qui manque pour qu'un mail arrive, et, portail par portail, si une
 * demande réelle est déjà arrivée jusqu'à une fiche. Une réception n'est dite « vérifiée » qu'après ce premier vrai mail
 * [R669] : une configuration remplie ne prouve pas que le routage de Cloudflare l'envoie bien au Worker.
 *
 * La direction seule le lit [R16] ; la réponse ne porte que des noms de réglages, des nombres et des dates, jamais une
 * adresse ni une fiche [R13].
 */
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Viewer } from '../acces/droits.ts';
import { PORTAL_DOMAINS } from '../reception/adaptateurs.ts';

/** Les réglages du Worker lus pour la réception des mails : seule leur présence compte ici. */
export interface MailIntakeSettings {
  mode: string | undefined;
  networkId: string | undefined;
  forwardTo: string | undefined;
  ownAddresses: string | undefined;
}

export type MailIntakeSetting = 'MODE' | 'MAIL_NETWORK_ID' | 'MAIL_FORWARD_TO' | 'MAIL_OWN_ADDRESSES';

export interface MailSourceState {
  /** Un portail de `PORTAL_DOMAINS`, ou « direct » pour les mails écrits par le client lui-même. */
  source: string;
  status: 'verifiee' | 'non_verifiee';
  /** Le dernier mail de cette source arrivé jusqu'à une fiche, ou null. */
  lastReceivedAt: string | null;
  /** Les mails de cette source arrivés jusqu'à une fiche, sur 30 jours. */
  last30Days: number;
}

export interface MailIntakeState {
  /** Vrai quand plus aucun réglage ne manque et que ce réseau est celui qui reçoit. */
  configured: boolean;
  missing: MailIntakeSetting[];
  /** Le réseau qui lit n'est pas celui des mails reçus : rien ne lui arrivera. */
  otherNetwork: boolean;
  sources: MailSourceState[];
}

export type MailIntakeResult = { ok: true; value: MailIntakeState } | { ok: false; rule: 'R16'; code: 'role' };

const DAY = 86_400_000;

export async function mailIntakeState(
  db: SqlDatabase,
  journal: JournalStore,
  viewer: Viewer,
  settings: MailIntakeSettings,
  now: () => Date = () => new Date(),
): Promise<MailIntakeResult> {
  if (viewer.role !== 'direction') {
    await appendEvent(
      journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: 'captation:mail', data: { rule: 'R16', role: String(viewer.role), kind: 'etat_mail', code: 'role' } },
      now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }
  const missing: MailIntakeSetting[] = [];
  if (settings.mode !== 'essai') missing.push('MODE');
  if (!settings.networkId?.trim()) missing.push('MAIL_NETWORK_ID');
  if (!settings.forwardTo?.trim()) missing.push('MAIL_FORWARD_TO');
  if (!settings.ownAddresses?.trim()) missing.push('MAIL_OWN_ADDRESSES');
  const otherNetwork = !!settings.networkId?.trim() && settings.networkId.trim() !== viewer.networkId;
  const since = new Date(now().getTime() - 30 * DAY).toISOString();
  // Seuls comptent les mails rattachés à une fiche : un illisible ou un mail jamais traité ne prouve rien.
  const rows = await db.all<{ source: string; last_at: string | null; recent: number }>(
    `SELECT COALESCE(portal, 'direct') AS source, MAX(received_at) AS last_at,
            SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS recent
       FROM inbound_messages
      WHERE network_id = ? AND channel = 'email' AND kind IN ('email', 'portal_email') AND person_id IS NOT NULL
      GROUP BY COALESCE(portal, 'direct')`,
    [since, viewer.networkId],
  );
  const bySource = new Map(rows.map((r) => [r.source, r]));
  const names = ['direct', ...new Set(Object.values(PORTAL_DOMAINS))];
  const sources = names.map((source): MailSourceState => {
    const row = bySource.get(source);
    return {
      source,
      status: row?.last_at ? 'verifiee' : 'non_verifiee',
      lastReceivedAt: row?.last_at ?? null,
      last30Days: Number(row?.recent ?? 0),
    };
  });
  return { ok: true, value: { configured: missing.length === 0 && !otherNetwork, missing, otherNetwork, sources } };
}

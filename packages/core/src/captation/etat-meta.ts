/**
 * L'état de la captation Meta (AU033) : ce qui manque pour qu'une notification d'Instagram, de Facebook ou de WhatsApp
 * soit lue, et, canal par canal, si un vrai message est déjà arrivé jusqu'à une fiche et y a reçu un traitement
 * visible (réponse prête ou alerte à l'agent). Un canal n'est dit « vérifié » qu'après ce premier message [R670] :
 * des secrets rangés ne prouvent pas que l'application Meta est abonnée, ni que la signature concorde.
 *
 * La direction seule le lit [R16] ; la réponse ne porte que des noms de réglages, des nombres et des dates, jamais un
 * identifiant de compte, un texte ni une fiche [R13].
 */
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Viewer } from '../acces/droits.ts';

/** Les réglages du Worker lus pour les notifications de Meta : seule leur présence compte ici. */
export interface MetaIntakeSettings {
  mode: string | undefined;
  appSecret: string | undefined;
  verifyTokenSha256: string | undefined;
  networkId: string | undefined;
  ownIds: string | undefined;
  appIds: string | undefined;
}

export type MetaIntakeSetting = 'MODE' | 'META_APP_SECRET' | 'META_VERIFY_TOKEN_SHA256' | 'META_NETWORK_ID' | 'META_OWN_IDS' | 'META_APP_IDS';

export const META_INTAKE_CHANNELS = ['instagram', 'facebook', 'whatsapp'] as const;
export type MetaIntakeChannel = (typeof META_INTAKE_CHANNELS)[number];

export interface MetaIntakeChannelState {
  channel: MetaIntakeChannel;
  /** « verifiee » : au moins un message de ce canal est arrivé jusqu'à une fiche et y a été traité. */
  status: 'verifiee' | 'non_verifiee';
  /** Le dernier message de ce canal arrivé jusqu'à une fiche, ou null. */
  lastReceivedAt: string | null;
  /** Les messages de ce canal arrivés jusqu'à une fiche, sur 30 jours. */
  last30Days: number;
  /** Parmi eux, ceux qui ont une réponse prête ou une alerte à l'agent : le traitement visible. */
  treated30Days: number;
  /** Les notifications signées mais illisibles de ce canal, sur 30 jours : rangées et signalées, jamais jetées. */
  unreadable30Days: number;
}

export interface MetaIntakeState {
  /** Vrai quand plus aucun réglage ne manque et que ce réseau est celui des comptes Meta. */
  configured: boolean;
  missing: MetaIntakeSetting[];
  /** Le réseau qui lit n'est pas celui des comptes Meta : rien ne lui arrivera. */
  otherNetwork: boolean;
  channels: MetaIntakeChannelState[];
}

export type MetaIntakeResult = { ok: true; value: MetaIntakeState } | { ok: false; rule: 'R16'; code: 'role' };

const DAY = 86_400_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** Les réglages qui manquent ; une empreinte du jeton qui n'en est pas une compte comme absente. */
export function missingMetaSettings(settings: MetaIntakeSettings): MetaIntakeSetting[] {
  const missing: MetaIntakeSetting[] = [];
  const filled = (v: string | undefined): boolean => (v ?? '').split(',').some((x) => x.trim() !== '');
  if (settings.mode !== 'essai') missing.push('MODE');
  if (!filled(settings.appSecret)) missing.push('META_APP_SECRET');
  if (!HEX64.test((settings.verifyTokenSha256 ?? '').trim().toLowerCase())) missing.push('META_VERIFY_TOKEN_SHA256');
  if (!settings.networkId?.trim()) missing.push('META_NETWORK_ID');
  if (!filled(settings.ownIds)) missing.push('META_OWN_IDS');
  // Sans nos applications, une réponse de notre assistant reçue en écho passerait pour celle d'un humain [R21].
  if (!filled(settings.appIds)) missing.push('META_APP_IDS');
  return missing;
}

export async function metaIntakeState(
  db: SqlDatabase,
  journal: JournalStore,
  viewer: Viewer,
  settings: MetaIntakeSettings,
  now: () => Date = () => new Date(),
): Promise<MetaIntakeResult> {
  if (viewer.role !== 'direction') {
    await appendEvent(
      journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: 'captation:meta', data: { rule: 'R16', role: String(viewer.role), kind: 'etat_meta', code: 'role' } },
      now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }
  const missing = missingMetaSettings(settings);
  const otherNetwork = !!settings.networkId?.trim() && settings.networkId.trim() !== viewer.networkId;
  const since = new Date(now().getTime() - 30 * DAY).toISOString();
  // Un message ne compte que rattaché à une fiche ; il est « traité » avec une réponse livrée ou une alerte à l'agent.
  const rows = await db.all<{ channel: string; last_at: string | null; recent: number; treated: number; treated_ever: number; unreadable: number }>(
    `WITH lus AS (
       SELECT i.channel, i.status, i.received_at, i.person_id,
              CASE WHEN i.person_id IS NOT NULL AND (
                     -- L'ordre est celui des faits (occurred_at) : l'écho d'un humain est rangé avant le message du même lot.
                     -- Une réponse rangée ne suffit pas : un envoi coupé avant la livraison la laisse sans suite. Seule
                     -- compte une réponse livrée (boîte d'essai, accusé du canal, ou réponse d'un humain reçue en écho du canal), ou une
                     -- alerte à l'agent.
                     EXISTS (SELECT 1 FROM messages m JOIN messages r ON r.conversation_id = m.conversation_id AND r.network_id = m.network_id
                              WHERE m.id = i.message_id AND m.conversation_id IS NOT NULL AND r.direction = 'out' AND r.occurred_at >= m.occurred_at
                                AND (EXISTS (SELECT 1 FROM trial_outbox t WHERE t.message_id = r.id)
                                     OR EXISTS (SELECT 1 FROM outbound_refs o WHERE o.message_id = r.id AND o.network_id = r.network_id)
                                     OR EXISTS (SELECT 1 FROM human_replies h WHERE h.message_id = r.id AND h.network_id = r.network_id)))
                     -- Une alerte compte si elle est ouverte, ouverte de nouveau après ce message, ou vue après lui (elle le
                     -- couvrait encore ouverte) : seule une alerte déjà vue avant lui ne dit rien de lui.
                     OR EXISTS (SELECT 1 FROM messages m JOIN agent_alerts a ON a.conversation_id = m.conversation_id AND a.network_id = m.network_id
                                 WHERE m.id = i.message_id AND (a.seen_at IS NULL OR a.created_at >= m.created_at OR a.seen_at >= m.created_at))
                   ) THEN 1 ELSE 0 END AS treated
         FROM inbound_messages i
        WHERE i.network_id = ? AND i.channel IN ('instagram', 'facebook', 'whatsapp'))
     SELECT channel,
            MAX(CASE WHEN person_id IS NOT NULL THEN received_at END) AS last_at,
            SUM(CASE WHEN person_id IS NOT NULL AND received_at >= ? THEN 1 ELSE 0 END) AS recent,
            SUM(CASE WHEN treated = 1 AND received_at >= ? THEN 1 ELSE 0 END) AS treated,
            SUM(treated) AS treated_ever,
            SUM(CASE WHEN status = 'unreadable' AND received_at >= ? THEN 1 ELSE 0 END) AS unreadable
       FROM lus
      GROUP BY channel`,
    [viewer.networkId, since, since, since],
  );
  const byChannel = new Map(rows.map((r) => [r.channel, r]));
  const channels = META_INTAKE_CHANNELS.map((channel): MetaIntakeChannelState => {
    const row = byChannel.get(channel);
    const treated = Number(row?.treated ?? 0);
    return {
      channel,
      status: Number(row?.treated_ever ?? 0) > 0 ? 'verifiee' : 'non_verifiee',
      lastReceivedAt: row?.last_at ?? null,
      last30Days: Number(row?.recent ?? 0),
      treated30Days: treated,
      unreadable30Days: Number(row?.unreadable ?? 0),
    };
  });
  return { ok: true, value: { configured: missing.length === 0 && !otherNetwork, missing, otherNetwork, channels } };
}

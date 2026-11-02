/**
 * Transmission au vendeur et réponse horodatée (M09, O03) [R56, R57].
 *
 * - L'agent du bien valide la transmission de chaque offre au vendeur : par message, qui passe par le contrôle central
 *   des envois (horaires, exclusions, accords) en mode essai, ou au téléphone et en personne, qu'il atteste. Une offre
 *   n'est transmise qu'une fois.
 * - La réponse du vendeur (acceptation, refus, contre-offre) est rapportée par l'agent avec sa preuve et son heure. C'est
 *   la seule façon de changer l'état d'une offre : aucun programme n'accepte, ne refuse ni ne négocie [R57].
 * - Chaque jour, une offre enregistrée et pas transmise après le délai réglé est signalée à l'agent et à la direction,
 *   une fois [R56].
 *
 * Décidé, lecture prudente : le message au vendeur est écrit par le code, sans IA : le montant, la validité, la
 * référence du bien, jamais le nom de l'acquéreur ; il vise le propriétaire du bien (fiche liée au bien comme
 * « propriétaire ») ; refusé par le contrôle central, rien n'est transmis et la règle est rendue à l'agent, qui peut
 * transmettre de vive voix. Une acceptation d'une offre échue est refusée [R59]. Délai d'alerte : 24 heures.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { euros } from '../annonces/mentions.ts';
import { RegistreOffres, type Offer } from './registre-offres.ts';

const TIME_ZONE = 'Europe/Paris';
export const OFFER_PURPOSE = 'suivi_mandat';
export const DEFAULT_TRANSMISSION_DELAY_HOURS = 24;

export type OfferState = 'recue' | 'transmise' | 'acceptee' | 'refusee' | 'contre_offre' | 'echue';
export type Via = 'message' | 'telephone' | 'en_personne';
export type ResponseOutcome = 'acceptee' | 'refusee' | 'contre_offre';

/** Un instant complet : date, heure et fuseau (Z ou décalage). */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const PROOF_REF = /^preuves\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|jpg|png|eml|txt)$/;

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'unknown_offer' | 'unknown_property' | 'no_owner' | 'bad_via' | 'bad_proof' | 'bad_date' | 'bad_outcome' | 'already_transmitted' | 'already_answered' | 'not_transmitted' | 'other_accepted' }
  | { ok: false; rule: 'R59'; code: 'expired' }
  | { ok: false; rule: string; code: 'message_refused'; reason: string };

/** Le texte du message au vendeur, écrit par le code : ni nom de l'acquéreur, ni IA [R19]. */
export function transmissionText(offer: Offer, reference: string, firstName: string | null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const [y, m, d] = offer.validUntil.split('-');
  return `${hello} une offre écrite a été reçue pour votre bien réf. ${reference} : ${euros(offer.amountEur)}, valable jusqu'au ${d}/${m}/${y} inclus. Je vous appelle pour l'étudier avec vous.`;
}

export class TransmissionOffres {
  private readonly now: () => Date;
  private readonly registre: RegistreOffres;
  private readonly controle: ControleEnvois;
  private readonly delayHours: number;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; delayHours?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.delayHours = options.delayHours ?? DEFAULT_TRANSMISSION_DELAY_HOURS;
    this.registre = new RegistreOffres(db, acces, journal, { now: this.now, ...(options.newId ? { newId: options.newId } : {}) });
    const store = new FicheClient(db, { now: this.now });
    const unique = new FicheUnique(db, store, { now: this.now });
    // Seuls les canaux du mode essai : rien ne part réellement [R26].
    this.controle = new ControleEnvois(db, unique, new DecisionEnvoi(db, store, unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** L'offre et son bien, sous les droits du registre ; pour transmettre ou rapporter une réponse, l'agent du bien seul. */
  async offerFor(viewer: Viewer, offerId: string, agentOnly: boolean): Promise<{ ok: true; offer: Offer; networkId: string; agentId: string } | Refusal | Problem> {
    const row = await this.db.first<{ property_id: string; network_id: string }>('SELECT property_id, network_id FROM offer_register WHERE id = ?', [offerId]);
    if (!row || row.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `offer:${offerId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'offer', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_offer' };
    }
    const g = await this.registre.gate(viewer, row.property_id);
    if (!g.ok) return g as Refusal | Problem;
    if (agentOnly && (viewer.role !== 'agent' || viewer.userId !== g.agentId)) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `offer:${offerId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'offer', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const list = await this.registre.list(viewer, row.property_id);
    if (!list.ok) return list as Refusal | Problem;
    return { ok: true, offer: list.value.find((o) => o.id === offerId)!, networkId: g.networkId, agentId: g.agentId };
  }

  /**
   * Une autre offre du même bien est-elle déjà acceptée (réponse directe, dernière proposition acceptée, ou dossier
   * ouvert) ? Une seule offre acceptée à la fois par bien.
   */
  async otherAccepted(propertyId: string, offerId: string): Promise<boolean> {
    const direct = await this.db.first(
      `SELECT r.offer_id FROM offer_responses r JOIN offer_register o ON o.id = r.offer_id
       WHERE o.property_id = ? AND o.id <> ? AND r.outcome = 'acceptee' LIMIT 1`,
      [propertyId, offerId],
    );
    if (direct) return true;
    const proposal = await this.db.first(
      `SELECT p.id FROM offer_proposals p JOIN offer_register o ON o.id = p.offer_id JOIN proposal_responses r ON r.proposal_id = p.id
       WHERE o.property_id = ? AND o.id <> ? AND r.outcome = 'acceptee' LIMIT 1`,
      [propertyId, offerId],
    );
    if (proposal) return true;
    return !!(await this.db.first('SELECT id FROM sale_files WHERE property_id = ? AND offer_id <> ? LIMIT 1', [propertyId, offerId]));
  }

  /** L'état d'une offre, lu dans les seuls faits enregistrés. */
  async stateOf(offer: Offer, at: Date = this.now()): Promise<OfferState> {
    const response = await this.db.first<{ outcome: ResponseOutcome }>('SELECT outcome FROM offer_responses WHERE offer_id = ?', [offer.id]);
    if (response) return response.outcome;
    if (localTime(at, TIME_ZONE).date > offer.validUntil) return 'echue';
    return (await this.db.first('SELECT offer_id FROM offer_transmissions WHERE offer_id = ?', [offer.id])) ? 'transmise' : 'recue';
  }

  /** L'agent du bien transmet l'offre au vendeur : par message (contrôle central, essai), au téléphone ou en personne. */
  async transmit(viewer: Viewer, offerId: string, input: { via: unknown; channel?: unknown; at?: unknown }): Promise<{ ok: true; value: { via: Via; messageId: string | null } } | Refusal | Problem> {
    if (input.via !== 'message' && input.via !== 'telephone' && input.via !== 'en_personne') return { ok: false, rule: null, code: 'bad_via' };
    const found = await this.offerFor(viewer, offerId, true);
    if (!found.ok) return found;
    // L'heure vraie, attestée par l'agent qui note après coup : ni à venir, ni avant la réception. Le journal garde l'heure de la saisie.
    let at = this.now().toISOString();
    if (input.at !== undefined) {
      if (typeof input.at !== 'string' || !ISO_INSTANT.test(input.at) || !Number.isFinite(Date.parse(input.at)) || Date.parse(input.at) > this.now().getTime() || Date.parse(input.at) < Date.parse(found.offer.receivedAt)) return { ok: false, rule: null, code: 'bad_date' };
      at = new Date(input.at).toISOString();
    }
    if (await this.db.first('SELECT offer_id FROM offer_transmissions WHERE offer_id = ?', [offerId])) return { ok: false, rule: null, code: 'already_transmitted' };
    let messageId: string | null = null;
    if (input.via === 'message') {
      const channel = input.channel === 'sms' || input.channel === 'whatsapp' ? input.channel : 'email';
      const owner = await this.db.first<{ person_id: string; first_name: string | null; reference: string }>(
        `SELECT pr.person_id, pe.first_name, p.reference FROM project_properties pp JOIN projects pr ON pr.id = pp.project_id
         JOIN persons pe ON pe.id = pr.person_id JOIN properties p ON p.id = pp.property_id
         WHERE pp.property_id = ? AND pp.role = 'owned' ORDER BY pp.created_at LIMIT 1`,
        [found.offer.propertyId],
      );
      if (!owner) return { ok: false, rule: null, code: 'no_owner' };
      const sent = await this.controle.send({
        networkId: found.networkId,
        agentId: found.agentId,
        personId: owner.person_id,
        channel,
        kind: 'follow_up',
        purpose: OFFER_PURPOSE,
        subject: `offre:${offerId}`,
        fallbackTexts: [transmissionText(found.offer, owner.reference, owner.first_name)],
        // Les seuls nombres permis dans le texte : le montant, la référence et la date de validité [R10].
        figures: [euros(found.offer.amountEur), owner.reference, found.offer.validUntil.split('-').reverse().join('/')],
      });
      if (sent.status !== 'sent' || !sent.messageId) return { ok: false, rule: sent.rule ?? 'R13', code: 'message_refused', reason: sent.reason };
      messageId = sent.messageId;
    }
    const { changes } = await this.db.run(
      'INSERT INTO offer_transmissions (offer_id, network_id, via, message_id, at, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (offer_id) DO NOTHING',
      [offerId, found.networkId, input.via, messageId, at, this.actor(viewer)],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_transmitted' };
    await appendEvent(this.journal, { type: 'offre.transmise', actor: this.actor(viewer), subject: `offer:${offerId}`, data: { rule: 'R56', via: input.via } }, this.now);
    return { ok: true, value: { via: input.via, messageId } };
  }

  /**
   * La réponse du vendeur, rapportée par l'agent du bien avec sa preuve et son heure : la seule façon de changer l'état
   * d'une offre [R57]. Une offre non transmise ne reçoit pas de réponse ; une offre échue ne peut plus être acceptée [R59].
   */
  async respond(viewer: Viewer, offerId: string, input: { outcome: unknown; proofRef: unknown; respondedAt: unknown }): Promise<{ ok: true; value: { outcome: ResponseOutcome } } | Refusal | Problem> {
    if (input.outcome !== 'acceptee' && input.outcome !== 'refusee' && input.outcome !== 'contre_offre') return { ok: false, rule: null, code: 'bad_outcome' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    // Une heure complète avec son fuseau : jamais lue selon le fuseau du serveur.
    if (typeof input.respondedAt !== 'string' || !ISO_INSTANT.test(input.respondedAt) || !Number.isFinite(Date.parse(input.respondedAt)) || Date.parse(input.respondedAt) > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const found = await this.offerFor(viewer, offerId, true);
    if (!found.ok) return found;
    const transmitted = await this.db.first<{ at: string }>('SELECT at FROM offer_transmissions WHERE offer_id = ?', [offerId]);
    if (!transmitted) return { ok: false, rule: null, code: 'not_transmitted' };
    const respondedAt = new Date(input.respondedAt);
    // Le vendeur ne répond qu'à une offre qu'on lui a transmise : jamais avant la transmission.
    if (respondedAt.getTime() < Date.parse(found.offer.receivedAt) || respondedAt.getTime() < Date.parse(transmitted.at)) return { ok: false, rule: null, code: 'bad_date' };
    // Une acceptation arrivée après le dernier jour de validité, à Paris, ne vaut pas [R59].
    if (input.outcome === 'acceptee' && localTime(respondedAt, TIME_ZONE).date > found.offer.validUntil) return { ok: false, rule: 'R59', code: 'expired' };
    if (input.outcome === 'acceptee' && (await this.otherAccepted(found.offer.propertyId, offerId))) return { ok: false, rule: null, code: 'other_accepted' };
    // L'acceptation n'est rangée que si aucune autre offre du bien n'est acceptée, vérifié dans la même instruction :
    // deux acceptations simultanées ne passent jamais toutes les deux.
    const pid = found.offer.propertyId;
    const { changes } = await this.db.run(
      `INSERT INTO offer_responses (offer_id, network_id, outcome, proof_ref, responded_at, recorded_by, at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (? <> 'acceptee' OR (
          NOT EXISTS (SELECT 1 FROM offer_responses r JOIN offer_register o ON o.id = r.offer_id WHERE o.property_id = ? AND o.id <> ? AND r.outcome = 'acceptee')
          AND NOT EXISTS (SELECT 1 FROM proposal_responses r JOIN offer_proposals p ON p.id = r.proposal_id JOIN offer_register o ON o.id = p.offer_id WHERE o.property_id = ? AND o.id <> ? AND r.outcome = 'acceptee')
          AND NOT EXISTS (SELECT 1 FROM sale_files f WHERE f.property_id = ? AND f.offer_id <> ?))) ON CONFLICT (offer_id) DO NOTHING`,
      [offerId, found.networkId, input.outcome, input.proofRef, respondedAt.toISOString(), this.actor(viewer), this.now().toISOString(), input.outcome, pid, offerId, pid, offerId, pid, offerId],
    );
    if (changes !== 1) {
      if (await this.db.first('SELECT offer_id FROM offer_responses WHERE offer_id = ?', [offerId])) return { ok: false, rule: null, code: 'already_answered' };
      return { ok: false, rule: null, code: 'other_accepted' };
    }
    await appendEvent(this.journal, { type: 'offre.reponse', actor: this.actor(viewer), subject: `offer:${offerId}`, data: { rule: 'R57', outcome: input.outcome } }, this.now);
    return { ok: true, value: { outcome: input.outcome } };
  }

  /** L'historique horodaté d'une offre : reçue, enregistrée, contrôlée, transmise, réponse. */
  async history(viewer: Viewer, offerId: string): Promise<{ ok: true; value: { state: OfferState; events: { at: string; event: string }[] } } | Refusal | Problem> {
    const found = await this.offerFor(viewer, offerId, false);
    if (!found.ok) return found;
    const events: { at: string; event: string }[] = [
      { at: found.offer.receivedAt, event: 'recue' },
      { at: found.offer.at, event: 'enregistree' },
    ];
    for (const c of await this.db.all<{ checked_at: string }>('SELECT checked_at FROM offer_checks WHERE offer_id = ?', [offerId])) events.push({ at: c.checked_at, event: 'controlee' });
    const t = await this.db.first<{ at: string; via: string }>('SELECT at, via FROM offer_transmissions WHERE offer_id = ?', [offerId]);
    if (t) events.push({ at: t.at, event: `transmise:${t.via}` });
    const r = await this.db.first<{ responded_at: string; outcome: string }>('SELECT responded_at, outcome FROM offer_responses WHERE offer_id = ?', [offerId]);
    if (r) events.push({ at: r.responded_at, event: `reponse:${r.outcome}` });
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return { ok: true, value: { state: await this.stateOf(found.offer), events } };
  }

  /**
   * Le contrôle quotidien : chaque offre enregistrée depuis plus du délai réglé et pas transmise est signalée une fois,
   * à l'agent du bien et à la direction, par le journal [R56]. Rend les offres signalées ce jour.
   */
  async alertUntransmitted(networkId: string): Promise<string[]> {
    const limit = new Date(this.now().getTime() - this.delayHours * 3_600_000).toISOString();
    const rows = await this.db.all<{ id: string; agent_id: string; property_id: string }>(
      `SELECT o.id, o.agent_id, o.property_id FROM offer_register o
       WHERE o.network_id = ? AND o.at <= ? AND NOT EXISTS (SELECT 1 FROM offer_transmissions t WHERE t.offer_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM offer_untransmitted_alerts a WHERE a.offer_id = o.id) ORDER BY o.at`,
      [networkId, limit],
    );
    const alerted: string[] = [];
    const announce = (offerId: string, agentId: string) =>
      appendEvent(this.journal, { type: 'offre.non_transmise', actor: 'system:offres', subject: `offer:${offerId}`, data: { rule: 'R56', agent: `agent:${agentId}`, to: ['agent', 'direction'] } }, this.now);
    // Une alerte rangée dont l'annonce au journal a manqué (panne juste après) est annoncée au passage suivant, une fois.
    const pending = await this.db.all<{ offer_id: string; agent_id: string }>(
      'SELECT offer_id, agent_id FROM offer_untransmitted_alerts WHERE network_id = ? ORDER BY at',
      [networkId],
    );
    for (const p of pending) {
      const said = (await this.journal.bySubject(`offer:${p.offer_id}`)).some((e) => e.type === 'offre.non_transmise');
      if (!said) {
        await announce(p.offer_id, p.agent_id);
        alerted.push(p.offer_id);
      }
    }
    for (const r of rows) {
      const { changes } = await this.db.run('INSERT INTO offer_untransmitted_alerts (offer_id, network_id, agent_id, at) VALUES (?, ?, ?, ?) ON CONFLICT (offer_id) DO NOTHING', [r.id, networkId, r.agent_id, this.now().toISOString()]);
      if (changes !== 1) continue;
      await announce(r.id, r.agent_id);
      alerted.push(r.id);
    }
    return alerted;
  }
}

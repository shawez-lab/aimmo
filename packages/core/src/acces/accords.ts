/**
 * L'agent note et retire l'accord d'une personne (AC01) [R03, R202, R02, R04, R13, R16, R17].
 *
 * Plusieurs modules demandent un accord que rien ne rangeait : suivi de la vente, de la location, offres, valeur du bien.
 * Le contrôle central refusait donc leurs envois pour toujours [R03]. L'agent de la fiche, ou la direction, y note
 * maintenant l'accord que la personne lui a donné, avec sa finalité, son canal, sa date et sa preuve.
 *
 * Décidé, lecture prudente :
 * - liste fermée de finalités : ni celles que leur module range lui-même au moment du geste, ni la prospection des
 *   partenaires, tant que H32 n'est pas tranchée ;
 * - une personne exclue ou arrêtée ne reçoit aucun accord ; lever l'exclusion est un autre geste ;
 * - un accord daté d'avant un retrait ou une levée d'exclusion est refusé : antidater ne rouvre rien ;
 * - retirer ferme tous les accords de même finalité et de même canal sur les fiches réunies, sinon le doublon d'une
 *   fiche réunie laisserait l'envoi ouvert. La ligne et sa preuve restent [R17] ;
 * - la preuve reste sur la fiche, jamais au journal [R13].
 */
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel, Consent } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalData, JournalStore } from '../journal/types.ts';
import { consentInForce } from '../envoi/decision.ts';
import { localTime } from '../envoi/horaires.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';
import type { Acces } from './acces.ts';
import type { Viewer } from './droits.ts';
import { CALL_PURPOSES, callClosedAt, isCallRequest, lastCallRefusal, usableCallConsents, type CallNote } from './fiche-agent.ts';

/** Les finalités qu'un agent peut noter, avec leur libellé pour l'écran. */
export const AGENT_CONSENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  suivi_vente: 'Suivi de la vente',
  suivi_mandat: 'Suivi du mandat et des offres',
  suivi_location: 'Suivi de la location',
  value_tracking: 'Suivi de la valeur du bien',
  valuation_follow_up: 'Suivi de l’avis de valeur',
  alertes_biens: 'Alertes de biens',
  route_share: 'Partage de la tournée de visites',
  prospecting: 'Prospection',
  rappel_demande: 'Demande de rappel',
  buyer_search: 'Recherche rangée dans la fiche acquéreur',
});
export const AGENT_CONSENT_PURPOSES: readonly string[] = Object.freeze(Object.keys(AGENT_CONSENT_LABELS));
/** Les canaux où un premier contact demande un accord préalable [R03]. */
export const AGENT_CONSENT_CHANNELS: readonly Channel[] = Object.freeze(['email', 'phone', 'sms', 'whatsapp'] as const);
const PARIS = 'Europe/Paris';
export const MIN_CONSENT_PROOF = 10;
export const MAX_CONSENT_PROOF = 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export type AccordsResult<T> = { ok: true; value: T } | { ok: false; rule: string | null; code: string };
export interface ConsentInput {
  purpose?: unknown;
  channel?: unknown;
  proof?: unknown;
  /** Le jour où la personne l'a donné, à Paris. L'heure n'est jamais demandée, ni prise sur le téléphone. */
  givenOn?: unknown;
}

/** Un jour qui existe vraiment : le 31 février ne devient pas le 3 mars. */
function readDay(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day ? value : null;
}

export class AccordsFiche {
  private readonly now: () => Date;
  private readonly db: SqlDatabase | null;

  constructor(
    private readonly store: FicheClient,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; db?: SqlDatabase } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.db = options.db ?? null;
  }

  /** Les appels notés sur la fiche : un refus retire sa valeur à une demande plus ancienne [R204]. */
  private async callNotes(ids: string[]): Promise<CallNote[]> {
    if (!this.db) return [];
    return this.db.all<CallNote>(`SELECT outcome, basis, noted_at FROM call_notes WHERE person_id IN (${ids.map(() => '?').join(', ')})`, ids);
  }

  /** Note un accord. Déjà en cours pour cette finalité et ce canal : rend celui-là, sans ligne de plus. */
  async record(viewer: Viewer, personId: string, input: ConsentInput): Promise<AccordsResult<{ consentId: string; givenAt: string; already: boolean }>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return { ok: false, rule: 'R16', code: 'role' };
    const { purpose, channel, proof } = input;
    if (typeof purpose !== 'string' || !AGENT_CONSENT_PURPOSES.includes(purpose)) return { ok: false, rule: 'R202', code: 'bad_purpose' };
    if (typeof channel !== 'string' || !(AGENT_CONSENT_CHANNELS as readonly string[]).includes(channel)) return { ok: false, rule: 'R202', code: 'bad_channel' };
    const note = typeof proof === 'string' ? proof.trim() : '';
    if (note.length < MIN_CONSENT_PROOF || note.length > MAX_CONSENT_PROOF || CONTROL.test(note)) return { ok: false, rule: 'R202', code: 'bad_proof' };
    const day = readDay(input.givenOn);
    if (!day) return { ok: false, rule: 'R202', code: 'bad_date' };
    const at = this.now();
    const today = localTime(at, PARIS).date;
    if (day > today) return { ok: false, rule: 'R202', code: 'future_date' };
    // Aujourd'hui vaut maintenant, à l'horloge du serveur. Un jour passé vaut son premier instant : l'accord ne passe
    // jamais pour plus récent que ce qui a été dit, et un retrait du même jour ferme la porte.
    const givenAt = day === today ? at : parisDayStart(day);

    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    const fiche = read.value;
    const root = fiche.person.id;

    const active = fiche.exclusions.filter((e) => !e.lifted_at);
    if (active.some((e) => e.reason === 'stop')) return { ok: false, rule: 'R04', code: 'stopped' };
    if (active.length > 0) return { ok: false, rule: 'R02', code: 'excluded' };
    const lifted = fiche.exclusions.find((e) => e.lifted_at && Date.parse(e.lifted_at) >= givenAt.getTime());
    if (lifted) return { ok: false, rule: lifted.reason === 'stop' ? 'R04' : 'R02', code: 'given_before_lift' };

    const same = fiche.consents.filter((c) => c.purpose === purpose && c.channel === channel);
    const opensCall = channel === 'phone' && CALL_PURPOSES.includes(purpose);
    // Un accord qui ne vaut plus ne retient pas le nouveau : la nouvelle preuve est rangée, pas perdue. Pour un appel, « vaut
    // encore » est le calcul du bouton (13 mois, retrait d'une autre finalité), sinon noter ne rouvrirait rien, sans le dire.
    const notes = opensCall ? await this.callNotes(fiche.members.map((m) => m.id)) : [];
    const opening = opensCall ? usableCallConsents(fiche, notes, at.getTime()).map((c) => c.id) : [];
    const current = same.find((c) => consentInForce(c, fiche, at.getTime()) && (!opensCall || opening.includes(c.id)));
    if (current) return { ok: true, value: { consentId: current.id, givenAt: current.given_at, already: true } };
    if (same.some((c) => c.withdrawn_at && Date.parse(c.withdrawn_at) >= givenAt.getTime())) return { ok: false, rule: 'R03', code: 'given_before_withdrawal' };
    // Par téléphone, un retrait ferme aussi les autres finalités d'appel : l'accord accepté ne rouvrirait rien [R03].
    if (opensCall && givenAt.getTime() <= callClosedAt(fiche)) return { ok: false, rule: 'R03', code: 'given_before_withdrawal' };
    // Une demande datée d'avant le refus de la personne ne rouvre rien : autant le dire [R204].
    if (opensCall && isCallRequest({ purpose }) && givenAt.getTime() <= lastCallRefusal(notes, at.getTime())) return { ok: false, rule: 'R204', code: 'given_before_refusal' };

    const consent = await this.store.addConsent({
      networkId: viewer.networkId,
      agentId: fiche.person.agent_id,
      personId: root,
      purpose,
      channel: channel as Channel,
      proof: `Noté par ${viewer.role}:${viewer.userId}, le ${at.toISOString()} : ${note}`,
      givenAt,
    });
    await this.event('fiche.accord_note', viewer, root, { rule: 'R03', purpose, channel, consent: consent.id });
    return { ok: true, value: { consentId: consent.id, givenAt: consent.given_at, already: false } };
  }

  /** Retire un accord, et ceux de même finalité et de même canal sur les fiches réunies. La ligne reste [R17]. */
  async withdraw(viewer: Viewer, personId: string, consentId: string): Promise<AccordsResult<{ consentId: string; withdrawnAt: string }>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return { ok: false, rule: 'R16', code: 'role' };
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    const fiche = read.value;
    const target = fiche.consents.find((c) => c.id === consentId);
    // L'accord d'une autre fiche se refuse comme un accord inconnu : rien ne dit qu'il existe.
    if (!target) return { ok: false, rule: null, code: 'unknown_consent' };
    const open: Consent[] = fiche.consents.filter((c) => c.purpose === target.purpose && c.channel === target.channel && !c.withdrawn_at);
    if (open.length === 0 && target.withdrawn_at) return { ok: true, value: { consentId: target.id, withdrawnAt: target.withdrawn_at } };
    const at = this.now();
    for (const c of open) await this.store.withdrawConsent(c.id, at);
    await this.event('fiche.accord_retire', viewer, fiche.person.id, { rule: 'R03', purpose: target.purpose, channel: target.channel, consents: open.map((c) => c.id) });
    return { ok: true, value: { consentId: target.id, withdrawnAt: target.withdrawn_at ?? at.toISOString() } };
  }

  private async event(type: string, viewer: Viewer, personId: string, data: JournalData): Promise<void> {
    await appendEvent(this.journal, { type, actor: `${viewer.role}:${viewer.userId}`, subject: `person:${personId}`, data }, this.now);
  }
}

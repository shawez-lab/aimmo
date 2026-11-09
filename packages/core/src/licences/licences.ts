/**
 * La licence du logiciel aux agences hors réseau, à l'abonnement, à un seul tarif publié (HX73 ; Feuille de route,
 * phase 5, « puis licence du logiciel aux agences hors réseau » ; Offre aux agents, « Licence du logiciel ») [R654,
 * R655, R656, R657, R16, R17].
 *
 * Décidé, lecture prudente :
 *   - une licence ne se donne qu'une fois la phase 5 ouverte dans la porte des phases (HX71), et range l'empreinte de
 *     cette ouverture [R654] ;
 *   - l'agence est identifiée par son SIREN (clé juste), sa carte professionnelle (« CPI … ») encore valable et son
 *     département, connu de la carte des régions (HX72) ; l'agence peut être partout en France, hors région ouverte
 *     comprise : la licence n'est pas une entrée dans le réseau [R654] ;
 *   - l'agence devient son propre réseau dans AIMMO, né avec la licence : rien de ce que voit le réseau qui la donne ne
 *     lui est ouvert, et elle ne voit rien des autres agences sous licence. Une agence sous licence ne donne pas de
 *     licence [R657] ;
 *   - un seul tarif mensuel pour toutes les agences, fixé par la direction par versions ; aucune licence ne porte un
 *     autre prix que celui du tarif en vigueur au moment où elle est donnée : la demande n'a pas de champ de prix, et la
 *     base refuse un autre prix, même écrit à la main [R655]. Un nouveau tarif ne change pas les licences déjà données ;
 *     elles sont dites « à l'ancien tarif » ;
 *   - une licence naît active, puis se suspend, reprend ou se termine, par la direction seule et avec une raison ;
 *     terminée, elle ne bouge plus. Une carte professionnelle échue se dit à chaque lecture, rien ne se coupe seul
 *     [R656] ;
 *   - aucun prélèvement, aucun envoi, aucun compte : la facturation réelle et le prix réel sont des décisions de Shawez
 *     (`chantier/HUMAIN.md`). La reprise des données de l'agence à la fin de sa licence viendra dans une tâche à part.
 *
 * Jamais vu : aucune remise cachée. Le tarif se publie avec chaque changement daté, et chacun peut vérifier que toutes
 * les agences paient le même prix pour la même version : la base refuse toute licence à un autre prix.
 */
import type { Viewer } from '../acces/droits.ts';
import { luhnValid } from '../controle-location/entreprise.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { regionOfDepartment } from '../regions/regions.ts';
import { parisDay } from '../studio/bibliotheque.ts';

export const LICENCE_TARIFF_FIELDS = ['monthlyCents', 'reason'] as const;
export const LICENCE_GRANT_FIELDS = ['agencyName', 'siren', 'cardNumber', 'cardExpiresOn', 'department'] as const;
export const LICENCE_STATE_FIELDS = ['licenceId', 'state', 'reason'] as const;
export const LICENCE_STATES = ['active', 'suspendue', 'terminee'] as const;
export type LicenceState = (typeof LICENCE_STATES)[number];
/** Bornes du tarif mensuel, en centimes hors taxes : de 1 € à 100 000 € [R655]. */
export const LICENCE_MIN_CENTS = 100;
export const LICENCE_MAX_CENTS = 10_000_000;

const CARD = /^CPI [0-9A-Z ]{6,30}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type LicencesRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R654' | 'R655' | 'R656' | 'R657' | null; code: string };

export interface TariffLine {
  version: number;
  monthlyCents: number;
  decidedAt: string;
}

export interface LicenceLine {
  id: string;
  agencyName: string;
  siren: string;
  department: string;
  /** La région de la carte des régions (HX72), toujours connue. */
  region: string;
  grantedAt: string;
  state: LicenceState;
  stateSince: string;
  tariffVersion: number;
  monthlyCents: number;
  /** La licence a été donnée à un tarif qui n'est plus le tarif en vigueur [R655]. */
  oldTariff: boolean;
  cardExpiresOn: string;
  /** La carte professionnelle est échue à la date de Paris de la lecture : dit, rien ne se coupe seul [R656]. */
  cardExpired: boolean;
}

interface LicenceRow {
  id: string;
  network_id: string;
  licensee_network_id: string;
  agency_name: string;
  siren: string;
  card_number: string;
  card_expires_on: string;
  department: string;
  tariff_version: number;
  monthly_cents: number;
  granted_at: string;
}

interface StateRow {
  licence_id: string;
  version: number;
  state: LicenceState;
  decided_at: string;
}

function validDay(v: string): boolean {
  if (!DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Un SIREN de 9 chiffres dont la clé est juste ; les espaces sont permis [R654]. */
export function sirenValid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const siren = raw.replace(/\s+/g, '');
  return /^\d{9}$/.test(siren) && luhnValid(siren) ? siren : null;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

function onlyFields(input: unknown, fields: readonly string[]): Record<string, unknown> | 'bad_shape' | 'unknown_field' {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'bad_shape';
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !fields.includes(k))) return 'unknown_field';
  return raw;
}

export class LicencesLogiciel {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async deny(viewer: Viewer, kind: string): Promise<LicencesRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: Exclude<LicencesRefusal, { rule: 'R16' }>): Promise<LicencesRefusal> {
    await appendEvent(this.journal, { type: 'licences.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  /** Le réseau du lecteur est-il une agence sous licence ? */
  private async isLicensee(networkId: string): Promise<boolean> {
    return (await this.db.first<{ one: number }>('SELECT 1 AS one FROM software_licences WHERE licensee_network_id = ?', [networkId])) !== null;
  }

  /**
   * La direction d'un réseau qui donne des licences, jamais celle d'une agence sous licence [R16, R657]. Un refus est
   * écrit au journal.
   */
  private async grantor(viewer: Viewer, kind: string): Promise<LicencesRefusal | null> {
    if (viewer.role !== 'direction') return this.deny(viewer, kind);
    if (await this.isLicensee(viewer.networkId)) return this.refuse(viewer, { ok: false, rule: 'R657', code: 'agence_licenciee' });
    return null;
  }

  private async tariffs(networkId: string): Promise<TariffLine[]> {
    const rows = await this.db.all<{ version: number; monthly_cents: number; decided_at: string }>(
      'SELECT version, monthly_cents, decided_at FROM licence_tariffs WHERE network_id = ? ORDER BY version',
      [networkId],
    );
    return rows.map((r) => ({ version: Number(r.version), monthlyCents: Number(r.monthly_cents), decidedAt: r.decided_at }));
  }

  private async phase5(networkId: string): Promise<string | null> {
    const row = await this.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE network_id = ? AND phase = 5', [networkId]);
    return row?.evidence_hash ?? null;
  }

  /** Fixe le tarif mensuel, un seul pour toutes les agences ; une version s'ajoute [R655]. */
  async setTariff(viewer: Viewer, input: unknown): Promise<{ ok: true; value: TariffLine } | LicencesRefusal> {
    const denied = await this.grantor(viewer, 'licence_tariff');
    if (denied) return denied;
    const raw = onlyFields(input, LICENCE_TARIFF_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: null, code: raw });
    const cents = raw.monthlyCents;
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < LICENCE_MIN_CENTS || cents > LICENCE_MAX_CENTS) {
      return this.refuse(viewer, { ok: false, rule: 'R655', code: 'bad_price' });
    }
    const reason = clean(raw.reason);
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const net = viewer.networkId;
    const current = (await this.tariffs(net)).at(-1);
    if (current?.monthlyCents === cents) return this.refuse(viewer, { ok: false, rule: 'R655', code: 'tarif_inchange' });
    const line: TariffLine = { version: (current?.version ?? 0) + 1, monthlyCents: cents, decidedAt: this.now().toISOString() };
    try {
      await this.db.run('INSERT INTO licence_tariffs (network_id, version, monthly_cents, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)', [
        net,
        line.version,
        cents,
        reason,
        this.actor(viewer),
        line.decidedAt,
      ]);
    } catch {
      return this.refuse(viewer, { ok: false, rule: 'R655', code: 'conflit' });
    }
    await appendEvent(this.journal, { type: 'licences.tarif', actor: this.actor(viewer), subject: `network:${net}`, data: { rule: 'R655', version: line.version, monthlyCents: cents } }, this.now);
    return { ok: true, value: line };
  }

  /**
   * Donne une licence à une agence hors réseau, qui naît comme son propre réseau [R654, R655, R657]. Aucun prix dans la
   * demande : celui du tarif en vigueur s'applique.
   */
  async grant(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { id: string; licenseeNetworkId: string; tariffVersion: number; monthlyCents: number } } | LicencesRefusal> {
    const denied = await this.grantor(viewer, 'licence_grant');
    if (denied) return denied;
    const raw = onlyFields(input, LICENCE_GRANT_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: raw === 'unknown_field' ? 'R655' : null, code: raw });
    const agencyName = clean(raw.agencyName);
    if (agencyName.length < 2 || agencyName.length > 120) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_name' });
    const siren = sirenValid(raw.siren);
    if (siren === null) return this.refuse(viewer, { ok: false, rule: 'R654', code: 'siren_invalide' });
    const card = clean(raw.cardNumber).toUpperCase();
    if (!CARD.test(card)) return this.refuse(viewer, { ok: false, rule: 'R654', code: 'carte_invalide' });
    const expires = typeof raw.cardExpiresOn === 'string' ? raw.cardExpiresOn : '';
    if (!validDay(expires)) return this.refuse(viewer, { ok: false, rule: 'R654', code: 'carte_invalide' });
    if (expires < parisDay(this.now())) return this.refuse(viewer, { ok: false, rule: 'R654', code: 'carte_echue' });
    const department = typeof raw.department === 'string' ? raw.department.trim().toUpperCase() : '';
    if (regionOfDepartment(department) === null) return this.refuse(viewer, { ok: false, rule: 'R654', code: 'departement_inconnu' });
    const net = viewer.networkId;
    const phase5 = await this.phase5(net);
    if (phase5 === null) return this.refuse(viewer, { ok: false, rule: 'R654', code: 'phase5_fermee' });
    const tariff = (await this.tariffs(net)).at(-1);
    if (tariff === undefined) return this.refuse(viewer, { ok: false, rule: 'R655', code: 'tarif_absent' });
    if (await this.db.first('SELECT 1 AS one FROM software_licences WHERE network_id = ? AND siren = ?', [net, siren])) {
      return this.refuse(viewer, { ok: false, rule: 'R654', code: 'deja_licenciee' });
    }
    const id = this.newId();
    const licenseeNetworkId = this.newId();
    const at = this.now().toISOString();
    try {
      await runBatch(this.db, [
        { sql: 'INSERT INTO networks (id, name, created_at) VALUES (?, ?, ?)', params: [licenseeNetworkId, agencyName, at] },
        {
          sql: `INSERT INTO software_licences (id, network_id, licensee_network_id, agency_name, siren, card_number, card_expires_on, department,
            tariff_version, monthly_cents, phase5_hash, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [id, net, licenseeNetworkId, agencyName, siren, card, expires, department, tariff.version, tariff.monthlyCents, phase5, this.actor(viewer), at],
        },
      ]);
    } catch {
      // Un tarif ou une licence passés entre la lecture et l'écriture : la base garde le premier, rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R655', code: 'conflit' });
    }
    await appendEvent(
      this.journal,
      { type: 'licences.licence', actor: this.actor(viewer), subject: `licence:${id}`, data: { rule: 'R654', network: net, tariffVersion: tariff.version, monthlyCents: tariff.monthlyCents } },
      this.now,
    );
    return { ok: true, value: { id, licenseeNetworkId, tariffVersion: tariff.version, monthlyCents: tariff.monthlyCents } };
  }

  /** Suspend, reprend ou termine une licence du réseau, avec une raison ; terminée, elle ne bouge plus [R656]. */
  async decide(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { licenceId: string; version: number; state: LicenceState } } | LicencesRefusal> {
    const denied = await this.grantor(viewer, 'licence_state');
    if (denied) return denied;
    const raw = onlyFields(input, LICENCE_STATE_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: null, code: raw });
    const state = raw.state;
    if (typeof state !== 'string' || !(LICENCE_STATES as readonly string[]).includes(state)) return this.refuse(viewer, { ok: false, rule: 'R656', code: 'bad_state' });
    const reason = clean(raw.reason);
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const licence = typeof raw.licenceId === 'string' ? await this.db.first<{ id: string }>('SELECT id FROM software_licences WHERE id = ? AND network_id = ?', [raw.licenceId, viewer.networkId]) : null;
    // Une licence d'un autre réseau est inconnue, sans rien dire de plus [R16].
    if (licence === null) return this.refuse(viewer, { ok: false, rule: null, code: 'not_found' });
    const states = await this.db.all<StateRow>('SELECT licence_id, version, state, decided_at FROM licence_states WHERE licence_id = ? ORDER BY version', [licence.id]);
    const last = states.at(-1);
    const current: LicenceState = last?.state ?? 'active';
    if (current === 'terminee') return this.refuse(viewer, { ok: false, rule: 'R656', code: 'terminee' });
    if (current === state) return this.refuse(viewer, { ok: false, rule: 'R656', code: 'etat_inchange' });
    const version = Number(last?.version ?? 0) + 1;
    try {
      await this.db.run('INSERT INTO licence_states (licence_id, version, state, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)', [
        licence.id,
        version,
        state,
        reason,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch {
      return this.refuse(viewer, { ok: false, rule: 'R656', code: 'conflit' });
    }
    await appendEvent(this.journal, { type: 'licences.etat', actor: this.actor(viewer), subject: `licence:${licence.id}`, data: { rule: 'R656', version, state } }, this.now);
    return { ok: true, value: { licenceId: licence.id, version, state: state as LicenceState } };
  }

  private async lines(rows: readonly LicenceRow[], currentTariff: number | null): Promise<LicenceLine[]> {
    const today = parisDay(this.now());
    const out: LicenceLine[] = [];
    for (const r of rows) {
      const last = await this.db.first<StateRow>('SELECT licence_id, version, state, decided_at FROM licence_states WHERE licence_id = ? ORDER BY version DESC LIMIT 1', [r.id]);
      out.push({
        id: r.id,
        agencyName: r.agency_name,
        siren: r.siren,
        department: r.department,
        region: regionOfDepartment(r.department) ?? '',
        grantedAt: r.granted_at,
        state: last?.state ?? 'active',
        stateSince: last?.decided_at ?? r.granted_at,
        tariffVersion: Number(r.tariff_version),
        monthlyCents: Number(r.monthly_cents),
        oldTariff: currentTariff !== null && Number(r.tariff_version) !== currentTariff,
        cardExpiresOn: r.card_expires_on,
        cardExpired: r.card_expires_on < today,
      });
    }
    return out;
  }

  /** Les licences données par le réseau, pour sa direction seule ; la lecture est écrite au journal [R16, R656]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: { readAt: string; tariff: TariffLine | null; licences: LicenceLine[] } } | LicencesRefusal> {
    const denied = await this.grantor(viewer, 'licence_list');
    if (denied) return denied;
    const net = viewer.networkId;
    const tariff = (await this.tariffs(net)).at(-1) ?? null;
    const rows = await this.db.all<LicenceRow>('SELECT * FROM software_licences WHERE network_id = ? ORDER BY granted_at, rowid', [net]);
    const licences = await this.lines(rows, tariff?.version ?? null);
    await appendEvent(this.journal, { type: 'licences.lecture', actor: this.actor(viewer), subject: `network:${net}`, data: { rule: 'R16', licences: licences.length } }, this.now);
    return { ok: true, value: { readAt: this.now().toISOString(), tariff, licences } };
  }

  /**
   * Ce que lit la direction d'une agence sous licence : sa licence, et rien d'autre ; ni les autres agences, ni leur
   * nombre, ni rien du réseau qui la donne [R657, R16].
   */
  async mine(viewer: Viewer): Promise<{ ok: true; value: Omit<LicenceLine, 'siren' | 'region'> } | LicencesRefusal> {
    if (viewer.role !== 'direction') return this.deny(viewer, 'licence_mine');
    const row = await this.db.first<LicenceRow>('SELECT * FROM software_licences WHERE licensee_network_id = ?', [viewer.networkId]);
    if (row === null) return this.refuse(viewer, { ok: false, rule: 'R657', code: 'pas_de_licence' });
    const current = (await this.tariffs(row.network_id)).at(-1)?.version ?? null;
    const [line] = await this.lines([row], current);
    const { siren: _siren, region: _region, ...value } = line!;
    await appendEvent(this.journal, { type: 'licences.lecture', actor: this.actor(viewer), subject: `licence:${row.id}`, data: { rule: 'R657' } }, this.now);
    return { ok: true, value };
  }

  /**
   * Le tarif public : le prix en vigueur et chaque changement daté, sans aucune agence ni aucun nombre [R655, R657].
   * `null` tant qu'aucune licence ne peut se donner (phase 5 fermée ou aucun tarif).
   */
  async publicTariff(networkId: string): Promise<{ current: { monthlyCents: number; since: string }; history: { monthlyCents: number; from: string }[] } | null> {
    if ((await this.phase5(networkId)) === null) return null;
    const all = await this.tariffs(networkId);
    const current = all.at(-1);
    if (current === undefined) return null;
    return { current: { monthlyCents: current.monthlyCents, since: current.decidedAt }, history: all.map((t) => ({ monthlyCents: t.monthlyCents, from: t.decidedAt })) };
  }
}

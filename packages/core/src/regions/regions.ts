/**
 * Les régions s'ouvrent une par une, chacune sur la preuve de la phase 5 (HX72 ; Feuille de route, phase 5, « Ouverture
 * région par région » ; phase 4, « Recrutement en Bourgogne-Franche-Comté ») [R650, R651, R652, R653, R16, R17].
 *
 * Décidé, lecture prudente :
 *   - la liste des régions est celle de l'INSEE : 13 de métropole et 5 d'outre-mer ; chaque département est rattaché à
 *     une seule région ; un département inconnu n'a pas de région, jamais devinée [R650] ;
 *   - la Bourgogne-Franche-Comté (27), région de la phase 4, est ouverte d'office et ne se ferme pas [R650] ;
 *   - une région ne s'ouvre que si la phase 5 est ouverte dans la porte des phases (HX71) ; l'ouverture range
 *     l'empreinte de cette ouverture de la phase 5 [R651] ;
 *   - « région par région » : une nouvelle région ne s'ouvre pas tant qu'une autre, ouverte hors origine, l'est depuis
 *     moins de 90 jours (trois mois, comme la condition de la phase 4) ; une région fermée entre-temps ne retient
 *     rien [R652] ;
 *   - fermer reste possible, par la direction seule ; rien ne s'ouvre ni ne se ferme seul.
 *
 * Jamais vu : chaque décision est enchaînée à la précédente par son empreinte (SHA-256). La direction peut vérifier à
 * tout instant que la carte des régions n'a pas été réécrite, même par une écriture directe dans la base : la première
 * version cassée est dite, recoupée avec le journal qui garde chaque empreinte [R653]. Le public ne lit que les noms des régions ouvertes, sans aucun chiffre.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export interface Region {
  code: string;
  name: string;
  departments: readonly string[];
}

/** Les régions de l'INSEE et leurs départements [R650]. */
export const REGIONS: readonly Region[] = Object.freeze([
  { code: '01', name: 'Guadeloupe', departments: ['971'] },
  { code: '02', name: 'Martinique', departments: ['972'] },
  { code: '03', name: 'Guyane', departments: ['973'] },
  { code: '04', name: 'La Réunion', departments: ['974'] },
  { code: '06', name: 'Mayotte', departments: ['976'] },
  { code: '11', name: 'Île-de-France', departments: ['75', '77', '78', '91', '92', '93', '94', '95'] },
  { code: '24', name: 'Centre-Val de Loire', departments: ['18', '28', '36', '37', '41', '45'] },
  { code: '27', name: 'Bourgogne-Franche-Comté', departments: ['21', '25', '39', '58', '70', '71', '89', '90'] },
  { code: '28', name: 'Normandie', departments: ['14', '27', '50', '61', '76'] },
  { code: '32', name: 'Hauts-de-France', departments: ['02', '59', '60', '62', '80'] },
  { code: '44', name: 'Grand Est', departments: ['08', '10', '51', '52', '54', '55', '57', '67', '68', '88'] },
  { code: '52', name: 'Pays de la Loire', departments: ['44', '49', '53', '72', '85'] },
  { code: '53', name: 'Bretagne', departments: ['22', '29', '35', '56'] },
  { code: '75', name: 'Nouvelle-Aquitaine', departments: ['16', '17', '19', '23', '24', '33', '40', '47', '64', '79', '86', '87'] },
  { code: '76', name: 'Occitanie', departments: ['09', '11', '12', '30', '31', '32', '34', '46', '48', '65', '66', '81', '82'] },
  { code: '84', name: 'Auvergne-Rhône-Alpes', departments: ['01', '03', '07', '15', '26', '38', '42', '43', '63', '69', '73', '74'] },
  { code: '93', name: "Provence-Alpes-Côte d'Azur", departments: ['04', '05', '06', '13', '83', '84'] },
  { code: '94', name: 'Corse', departments: ['2A', '2B'] },
] satisfies Region[]);

/** La région de la phase 4, ouverte d'office, jamais fermée [R650]. */
export const HOME_REGION = '27';
/** Le délai, en jours, avant qu'une nouvelle région puisse suivre la précédente [R652]. */
export const REGION_SPACING_DAYS = 90;
export const REGION_DECISION_FIELDS = ['region', 'open', 'reason'] as const;
/** L'empreinte qui précède la première version d'un réseau. */
export const REGION_CHAIN_START = '0'.repeat(64);

const REGION_BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));
const REGION_BY_DEPARTMENT = new Map(REGIONS.flatMap((r) => r.departments.map((d) => [d, r.code] as const)));
const DAY_MS = 86_400_000;

/** La région d'un département, ou `null` si le département n'est pas connu : jamais devinée [R650]. */
export function regionOfDepartment(department: unknown): string | null {
  if (typeof department !== 'string') return null;
  return REGION_BY_DEPARTMENT.get(department.trim().toUpperCase()) ?? null;
}

export type RegionsRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R650' | 'R651' | 'R652' | null; code: string; until?: string };

export interface RegionLine {
  code: string;
  name: string;
  home: boolean;
  open: boolean;
  /** Le moment de la décision qui l'a ouverte, `null` pour la région d'origine et une région fermée. */
  openSince: string | null;
  /** La version de la dernière décision, `null` si aucune. */
  version: number | null;
}

export interface RegionsReport {
  readAt: string;
  phase5Open: boolean;
  regions: RegionLine[];
  /** Une nouvelle région peut-elle s'ouvrir maintenant, et sinon pourquoi. */
  openable: { ok: boolean; reasons: string[]; until: string | null };
}

export type ChainCheck = { intact: true; versions: number } | { intact: false; versions: number; brokenAt: number };

interface DecisionRow {
  network_id: string;
  version: number;
  region: string;
  is_open: number;
  reason: string;
  decided_by: string;
  decided_at: string;
  phase5_hash: string | null;
  prev_hash: string;
  hash: string;
}

/** L'empreinte d'une décision : la précédente, puis chaque colonne rangée, dans cet ordre [R653]. */
export const regionDecisionHash = (d: Omit<DecisionRow, 'hash'>): Promise<string> =>
  sha256(JSON.stringify([d.prev_hash, d.network_id, Number(d.version), d.region, Number(d.is_open), d.reason, d.decided_by, d.decided_at, d.phase5_hash]));

const byName = (a: string, b: string): number => a.localeCompare(b, 'fr');

export class RegionsOuvertes {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<RegionsRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: Exclude<RegionsRefusal, { rule: 'R16' }>): Promise<RegionsRefusal> {
    await appendEvent(this.journal, { type: 'regions.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  private async decisions(networkId: string): Promise<DecisionRow[]> {
    return this.db.all<DecisionRow>(
      'SELECT network_id, version, region, is_open, reason, decided_by, decided_at, phase5_hash, prev_hash, hash FROM region_decisions WHERE network_id = ? ORDER BY version',
      [networkId],
    );
  }

  /** L'empreinte de l'ouverture de la phase 5, lue à l'instant dans la porte des phases (HX71), ou `null` [R651]. */
  private async phase5(networkId: string): Promise<string | null> {
    const row = await this.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE network_id = ? AND phase = 5', [networkId]);
    return row?.evidence_hash ?? null;
  }

  /** L'état de chaque région : la décision la plus haute vaut ; la région d'origine est ouverte d'office [R650]. */
  private static lines(rows: readonly DecisionRow[]): RegionLine[] {
    const last = new Map<string, DecisionRow>();
    for (const r of rows) last.set(r.region, r);
    return REGIONS.map((region) => {
      const home = region.code === HOME_REGION;
      const d = last.get(region.code);
      const open = home || Number(d?.is_open) === 1;
      return { code: region.code, name: region.name, home, open, openSince: !home && open ? d!.decided_at : null, version: d ? Number(d.version) : null };
    });
  }

  /** Une nouvelle région peut-elle s'ouvrir maintenant [R651, R652] ? */
  private openable(phase5: string | null, lines: readonly RegionLine[]): RegionsReport['openable'] {
    const reasons: string[] = [];
    if (phase5 === null) reasons.push('phase5_fermee');
    let until: string | null = null;
    const nowMs = this.now().getTime();
    for (const line of lines) {
      if (line.home || !line.open || line.openSince === null) continue;
      const end = Date.parse(line.openSince) + REGION_SPACING_DAYS * DAY_MS;
      if (end > nowMs && (until === null || end > Date.parse(until))) until = new Date(end).toISOString();
    }
    if (until !== null) reasons.push('region_recente');
    return { ok: reasons.length === 0, reasons, until };
  }

  /** L'état des régions, pour la direction seule ; la lecture est écrite au journal avant d'être rendue [R16]. */
  async report(viewer: Viewer): Promise<{ ok: true; value: RegionsReport } | RegionsRefusal> {
    const denied = await this.direction(viewer, 'regions_report');
    if (denied) return denied;
    const [rows, phase5] = await Promise.all([this.decisions(viewer.networkId), this.phase5(viewer.networkId)]);
    const regions = RegionsOuvertes.lines(rows);
    const value: RegionsReport = { readAt: this.now().toISOString(), phase5Open: phase5 !== null, regions, openable: this.openable(phase5, regions) };
    await appendEvent(
      this.journal,
      { type: 'regions.lecture', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', open: regions.filter((r) => r.open).map((r) => r.code) } },
      this.now,
    );
    return { ok: true, value };
  }

  /**
   * Ouvre ou ferme une région, par la direction seule ; une version s'ajoute à la chaîne [R650, R651, R652, R653].
   * Une ouverture exige la phase 5 ouverte et aucune autre région ouverte depuis moins de 90 jours.
   */
  async decide(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { region: string; version: number; open: boolean; hash: string } } | RegionsRefusal> {
    const denied = await this.direction(viewer, 'region_decision');
    if (denied) return denied;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(REGION_DECISION_FIELDS as readonly string[]).includes(k))) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
    if (typeof raw.region !== 'string' || !REGION_BY_CODE.has(raw.region)) return this.refuse(viewer, { ok: false, rule: 'R650', code: 'region_inconnue' });
    if (raw.region === HOME_REGION) return this.refuse(viewer, { ok: false, rule: 'R650', code: 'region_d_origine' });
    if (typeof raw.open !== 'boolean') return this.refuse(viewer, { ok: false, rule: null, code: 'bad_open' });
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const region = raw.region;
    const open = raw.open;
    const net = viewer.networkId;

    const rows = await this.decisions(net);
    const lines = RegionsOuvertes.lines(rows);
    const current = lines.find((l) => l.code === region)!;
    if (current.open === open) return this.refuse(viewer, { ok: false, rule: 'R651', code: open ? 'deja_ouverte' : 'deja_fermee' });
    let phase5: string | null = null;
    if (open) {
      phase5 = await this.phase5(net);
      if (phase5 === null) return this.refuse(viewer, { ok: false, rule: 'R651', code: 'phase5_fermee' });
      const check = this.openable(phase5, lines);
      if (check.until !== null) {
        const refusal = await this.refuse(viewer, { ok: false, rule: 'R652', code: 'region_recente' });
        return { ...refusal, until: check.until } as RegionsRefusal;
      }
    }
    const last = rows.at(-1);
    const row: Omit<DecisionRow, 'hash'> = {
      network_id: net,
      version: Number(last?.version ?? 0) + 1,
      region,
      is_open: open ? 1 : 0,
      reason,
      decided_by: this.actor(viewer),
      decided_at: this.now().toISOString(),
      phase5_hash: phase5,
      prev_hash: last?.hash ?? REGION_CHAIN_START,
    };
    const hash = await regionDecisionHash(row);
    try {
      await this.db.run(
        'INSERT INTO region_decisions (network_id, version, region, is_open, reason, decided_by, decided_at, phase5_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.network_id, row.version, row.region, row.is_open, row.reason, row.decided_by, row.decided_at, row.phase5_hash, row.prev_hash, hash],
      );
    } catch {
      // Une autre décision est passée entre la lecture et l'écriture : la base garde la première, rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R651', code: 'conflit' });
    }
    await appendEvent(this.journal, { type: 'regions.decision', actor: this.actor(viewer), subject: `network:${net}`, data: { rule: 'R651', region, version: row.version, open, hash } }, this.now);
    return { ok: true, value: { region, version: row.version, open, hash } };
  }

  /**
   * Recompte la chaîne des décisions depuis la première, pour la direction seule [R653] : une version qui manque, une
   * empreinte précédente qui ne suit pas ou une ligne changée la cassent, et la première version cassée est dite.
   */
  async verify(viewer: Viewer): Promise<{ ok: true; value: ChainCheck } | RegionsRefusal> {
    const denied = await this.direction(viewer, 'regions_verify');
    if (denied) return denied;
    const rows = await this.decisions(viewer.networkId);
    let prev = REGION_CHAIN_START;
    let value: ChainCheck = { intact: true, versions: rows.length };
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      const expected = i + 1;
      const recomputed = await regionDecisionHash(r);
      if (Number(r.version) !== expected || r.prev_hash !== prev || r.hash !== recomputed) {
        value = { intact: false, versions: rows.length, brokenAt: Math.min(Number(r.version), expected) };
        break;
      }
      prev = r.hash;
    }
    // Recoupée avec le journal, qui garde chaque décision et son empreinte : une fin de chaîne retirée, ou une chaîne
    // réécrite en entier avec des empreintes recalculées, ne s'y retrouve pas. Une décision rangée dont l'écriture au
    // journal a manqué est dite cassée aussi : la lecture prudente préfère un doute dit à une carte crue sans preuve.
    if (value.intact) {
      const events = await this.db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? AND subject = ? ORDER BY seq', ['regions.decision', `network:${viewer.networkId}`]);
      const logged = new Map<number, string>();
      for (const e of events) {
        const d = JSON.parse(e.data) as { version?: unknown; hash?: unknown };
        if (typeof d.version === 'number' && typeof d.hash === 'string' && !logged.has(d.version)) logged.set(d.version, d.hash);
      }
      const total = Math.max(rows.length, ...logged.keys(), 0);
      for (let v = 1; v <= total; v += 1) {
        const row = rows[v - 1];
        if (!row || logged.get(v) !== row.hash) {
          value = { intact: false, versions: rows.length, brokenAt: v };
          break;
        }
      }
    }
    await appendEvent(
      this.journal,
      { type: 'regions.verification', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R653', ...value } },
      this.now,
    );
    return { ok: true, value };
  }

  /** Ce que lit le public : les noms des régions ouvertes, par ordre alphabétique, et rien d'autre [R653]. */
  async openRegionNames(networkId: string): Promise<string[]> {
    const lines = RegionsOuvertes.lines(await this.decisions(networkId));
    return lines
      .filter((l) => l.open)
      .map((l) => l.name)
      .sort(byName);
  }

  /** Un département est-il dans une région ouverte ? Un département inconnu ne l'est jamais [R650]. */
  async departmentOpen(networkId: string, department: unknown): Promise<boolean> {
    const code = regionOfDepartment(department);
    if (code === null) return false;
    const lines = RegionsOuvertes.lines(await this.decisions(networkId));
    return lines.some((l) => l.code === code && l.open);
  }
}

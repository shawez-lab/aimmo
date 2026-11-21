/**
 * Le paramétrage géographique du réseau (AU039 ; M03 Qualifier et attribuer ; audit A039) [R679].
 *
 * Les communes que la qualification et la recherche reconnaissent viennent de la base, rangées par la direction avec
 * leur code INSEE, par versions qui ne changent plus [R17]. Ouvrir AIMMO à Lyon, c'est inscrire Lyon et son code,
 * sans toucher au code. Un réseau qui n'a encore rien inscrit garde la liste du pilote dijonnais, dite « par défaut » :
 * dès sa première commune inscrite, seule sa liste compte.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEFAULT_COMMUNES } from '../qualification/regles.ts';

export const NETWORK_COMMUNE_FIELDS = ['inseeCode', 'name', 'listed', 'reason'] as const;

export interface NetworkCommune {
  name: string;
  inseeCode: string;
}

export interface NetworkGeography {
  /** `reseau` : la liste inscrite par la direction ; `defaut` : rien d'inscrit, la liste du pilote. */
  source: 'reseau' | 'defaut';
  /** Par ordre alphabétique ; le code INSEE est nul seulement pour la liste par défaut. */
  communes: { name: string; inseeCode: string | null }[];
}

export type GeographyRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R679' | null; code: string };

/** Un code INSEE de commune : cinq chiffres, ou 2A / 2B suivis de trois chiffres pour la Corse. */
export const isInseeCode = (v: unknown): v is string => typeof v === 'string' && /^(?:\d{5}|2[AB]\d{3})$/.test(v);

const clean = (v: string): string => v.trim().replace(/\s+/g, ' ');
const plainName = (v: string): string =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'fr');

interface Options {
  now?: () => Date;
  /** La liste d'un réseau qui n'a encore rien inscrit. */
  fallback?: readonly string[];
}

export class GeographieReseau {
  private readonly now: () => Date;
  private readonly fallback: readonly string[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fallback = options.fallback ?? DEFAULT_COMMUNES;
  }

  /** Les communes inscrites du réseau, la version la plus haute de chacune. */
  private async rows(networkId: string): Promise<{ insee_code: string; name: string; is_listed: number; version: number }[]> {
    return this.db.all(
      `SELECT c.insee_code, c.commune AS name, c.is_listed, c.version FROM network_communes c
        WHERE c.network_id = ? AND c.version = (SELECT MAX(d.version) FROM network_communes d WHERE d.network_id = c.network_id AND d.insee_code = c.insee_code)`,
      [networkId],
    );
  }

  /** La géographie du réseau, telle que la qualification et la recherche la lisent [R679]. */
  async geography(networkId: string): Promise<NetworkGeography> {
    const rows = await this.rows(networkId);
    if (rows.length === 0) return { source: 'defaut', communes: [...this.fallback].map((name) => ({ name, inseeCode: null })).sort(byName) };
    return {
      source: 'reseau',
      communes: rows
        .filter((r) => Number(r.is_listed) === 1)
        .map((r) => ({ name: r.name, inseeCode: r.insee_code }))
        .sort(byName),
    };
  }

  /** Les seuls noms, pour lire un texte : une commune sortie de la liste n'est plus reconnue [R679]. */
  async names(networkId: string): Promise<readonly string[]> {
    return (await this.geography(networkId)).communes.map((c) => c.name);
  }

  /** Le code INSEE d'une commune inscrite, par son nom ; nul hors de la liste ou pour la liste par défaut. */
  async inseeOf(networkId: string, name: string): Promise<string | null> {
    const key = plainName(name);
    return (await this.geography(networkId)).communes.find((c) => plainName(c.name) === key)?.inseeCode ?? null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, refusal: GeographyRefusal): Promise<GeographyRefusal> {
    const type = refusal.rule === 'R16' ? 'acces.refuse' : 'geographie.refuse';
    const data = refusal.rule === 'R16' ? { rule: 'R16', role: String(viewer.role), kind: 'network_commune', code: 'role' } : { rule: refusal.rule, code: refusal.code };
    await appendEvent(this.journal, { type, actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data }, this.now);
    return refusal;
  }

  /**
   * La direction seule inscrit une commune ou la retire, avec une raison ; une version s'ajoute, rien ne change
   * [R679, R17, R16]. Deux communes inscrites ne portent jamais le même nom.
   */
  async decide(viewer: Viewer, input: unknown): Promise<{ ok: true; value: NetworkCommune & { version: number; listed: boolean } } | GeographyRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, { ok: false, rule: 'R16', code: 'role' });
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(NETWORK_COMMUNE_FIELDS as readonly string[]).includes(k))) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
    if (!isInseeCode(raw.inseeCode)) return this.refuse(viewer, { ok: false, rule: 'R679', code: 'bad_insee' });
    if (typeof raw.listed !== 'boolean') return this.refuse(viewer, { ok: false, rule: null, code: 'bad_listed' });
    const reason = typeof raw.reason === 'string' ? clean(raw.reason) : '';
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const inseeCode = raw.inseeCode;
    const rows = await this.rows(viewer.networkId);
    const last = rows.find((r) => r.insee_code === inseeCode);
    const current = last ? Number(last.is_listed) === 1 : false;
    if (current === raw.listed) return this.refuse(viewer, { ok: false, rule: 'R679', code: raw.listed ? 'deja_inscrite' : 'deja_retiree' });
    let name: string;
    if (raw.listed) {
      name = typeof raw.name === 'string' ? clean(raw.name) : '';
      if (name.length < 1 || name.length > 80 || !/\p{L}/u.test(name)) return this.refuse(viewer, { ok: false, rule: 'R679', code: 'bad_name' });
      const key = plainName(name);
      if (rows.some((r) => Number(r.is_listed) === 1 && r.insee_code !== inseeCode && plainName(r.name) === key)) return this.refuse(viewer, { ok: false, rule: 'R679', code: 'nom_deja_pris' });
    } else {
      // Retirer garde le nom inscrit : un nom envoyé avec un retrait n'est pas pris.
      if (raw.name !== undefined) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
      name = last!.name;
    }
    const version = Number(last?.version ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO network_communes (network_id, insee_code, version, commune, is_listed, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [viewer.networkId, inseeCode, version, name, raw.listed ? 1 : 0, reason, this.actor(viewer), this.now().toISOString()],
      );
    } catch {
      // Une autre décision sur la même commune est passée entre la lecture et l'écriture : rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R679', code: 'conflit' });
    }
    await appendEvent(
      this.journal,
      { type: 'geographie.commune', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { inseeCode, name, version, listed: raw.listed } },
      this.now,
    );
    return { ok: true, value: { inseeCode, name, version, listed: raw.listed } };
  }
}

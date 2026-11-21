/**
 * AU034 · La relève quotidienne de la pige par un vrai fournisseur d'annonces de particuliers [R671].
 *
 * Le fournisseur est celui que le réseau a choisi et dont il a le contrat : il expose les annonces de son secteur en
 * JSON, derrière une clé. Une relève qui dépasse ses limites (20 pages, 5 000 annonces) est une panne, rien n'est rangé. AIMMO ne lui envoie que la date depuis laquelle il veut les annonces : ni le réseau, ni une
 * commune, ni un nom. Chaque passage laisse une ligne dans `pige_runs`, réussi ou en panne, avec une raison d'une liste
 * fermée ; une panne est écrite au journal et dite à la direction et aux agents, jamais avalée [R13]. Les annonces
 * reçues passent par la même porte que toute relève : « pas d'agence » écarté, hors zone écarté, aucun texte gardé
 * [R273].
 */
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { PigeSource, RawAd } from './pige.ts';

export const PIGE_COLLECT_JOB = 'pige.releve';
/** La relève passe chaque jour à 6 h, heure de Paris, avant la journée des agents. */
export const PIGE_COLLECT_HOURS: readonly number[] = [6];
/** Sans relève réussie depuis 26 heures, la pige est dite en retard : un passage quotidien a été manqué. */
export const PIGE_LATE_AFTER_HOURS = 26;
export const PIGE_PAGE_LIMIT = 20;
export const PIGE_ADS_LIMIT = 5_000;

const HOUR = 3_600_000;

/** Les raisons d'une panne, en liste fermée : jamais le texte d'une erreur, qui pourrait porter une adresse ou une clé. */
export const PIGE_FAILURE_REASONS = ['acces_refuse', 'fournisseur_indisponible', 'reponse_illisible', 'releve_incomplete', 'reseau', 'autre'] as const;
export type PigeFailureReason = (typeof PIGE_FAILURE_REASONS)[number];

/** Une panne du fournisseur, avec sa raison de la liste fermée. */
export class PigeSourceError extends Error {
  constructor(readonly reason: PigeFailureReason) {
    super(`pige : ${reason}`);
    this.name = 'PigeSourceError';
  }
}

export type PigeFetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Les réglages du Worker pour le fournisseur ; seule leur forme est contrôlée ici. */
export interface PigeProviderSettings {
  /** `PIGE_SOURCE_URL` : l'adresse https des annonces du fournisseur. */
  url: string | undefined;
  /** `PIGE_SOURCE_TOKEN` (secret) : la clé donnée par le fournisseur. */
  token: string | undefined;
  /** `PIGE_NETWORK_ID` : le réseau dont le fournisseur couvre le secteur. */
  networkId: string | undefined;
}

export type PigeProviderSetting = 'PIGE_SOURCE_URL' | 'PIGE_SOURCE_TOKEN' | 'PIGE_NETWORK_ID';

/** L'adresse du fournisseur : en https, sans identifiant ni mot de passe, sans fragment. */
export function pigeProviderUrl(raw: string | undefined): URL | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  return url;
}

const TOKEN = /^[\x21-\x7e]{16,512}$/;

/** Les réglages qui manquent ; une adresse qui n'est pas en https ou une clé trop courte comptent comme absentes. */
export function missingPigeSettings(settings: PigeProviderSettings): PigeProviderSetting[] {
  const missing: PigeProviderSetting[] = [];
  if (!pigeProviderUrl(settings.url)) missing.push('PIGE_SOURCE_URL');
  if (!TOKEN.test((settings.token ?? '').trim())) missing.push('PIGE_SOURCE_TOKEN');
  if (!(settings.networkId ?? '').trim()) missing.push('PIGE_NETWORK_ID');
  return missing;
}

/**
 * Le fournisseur par `fetch`. Il rend `{ "ads": [ … ], "next": "<adresse>" }` : chaque annonce à la forme de `RawAd`
 * (`docs/PIGE.md`). La page suivante n'est suivie que sous la même adresse ; au plus 20 pages et 5 000 annonces.
 */
export class HttpPigeSource implements PigeSource {
  private readonly base: URL;
  private readonly token: string;

  constructor(
    private readonly fetcher: PigeFetcher,
    settings: { url: string; token: string },
  ) {
    const base = pigeProviderUrl(settings.url);
    if (!base || !TOKEN.test(settings.token.trim())) throw new Error('pige : réglages du fournisseur invalides');
    this.base = base;
    this.token = settings.token.trim();
  }

  /** Seule la date part : ni le réseau, ni une commune. */
  async ads(_networkId: string, since: Date): Promise<readonly RawAd[]> {
    const first = new URL(this.base.href);
    first.searchParams.set('since', since.toISOString());
    let url: string | null = first.href;
    const out: RawAd[] = [];
    for (let page = 0; url !== null && page < PIGE_PAGE_LIMIT; page += 1) {
      let res: Awaited<ReturnType<PigeFetcher>>;
      try {
        res = await this.fetcher(url, { headers: { accept: 'application/json', authorization: `Bearer ${this.token}` } });
      } catch {
        throw new PigeSourceError('reseau');
      }
      if (res.status === 401 || res.status === 403) throw new PigeSourceError('acces_refuse');
      if (!res.ok) throw new PigeSourceError(res.status >= 500 || res.status === 429 ? 'fournisseur_indisponible' : 'autre');
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new PigeSourceError('reponse_illisible');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new PigeSourceError('reponse_illisible');
      const record = body as Record<string, unknown>;
      const ads = record['ads'];
      if (!Array.isArray(ads)) throw new PigeSourceError('reponse_illisible');
      // Au-delà des limites, la relève n'est pas complète : c'est une panne, jamais une réussie sur une partie [R671].
      if (out.length + ads.length > PIGE_ADS_LIMIT) throw new PigeSourceError('releve_incomplete');
      for (const ad of ads) out.push((ad !== null && typeof ad === 'object' && !Array.isArray(ad) ? ad : {}) as RawAd);
      url = this.nextPage(record['next']);
    }
    if (url !== null) throw new PigeSourceError('releve_incomplete');
    return out;
  }

  /** La page suivante, seulement sous la même origine et le même chemin : jamais ailleurs, ni sans la clé attendue. */
  private nextPage(next: unknown): string | null {
    if (typeof next !== 'string' || next === '') return null;
    let url: URL;
    try {
      url = new URL(next, this.base);
    } catch {
      return null;
    }
    return url.origin === this.base.origin && url.pathname === this.base.pathname && !url.username && !url.password ? url.href : null;
  }
}

export interface PigeCollector {
  collect(networkId: string, source: PigeSource): Promise<{ added: number; noAgency: number; outside: number; unreadable: number }>;
}

export interface PigeRunResult {
  outcome: 'ok' | 'panne';
  reason: PigeFailureReason | null;
  received: number;
  added: number;
  noAgency: number;
  outside: number;
  unreadable: number;
}

/** Un passage : la relève par la porte commune, puis sa ligne dans `pige_runs` ; une panne au journal [R671, R13]. */
export async function runPigeCollect(
  db: SqlDatabase,
  journal: JournalStore,
  collector: PigeCollector,
  networkId: string,
  source: PigeSource,
  now: () => Date = () => new Date(),
): Promise<PigeRunResult> {
  const previous = await db.first<{ outcome: string }>('SELECT outcome FROM pige_runs WHERE network_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1', [networkId]);
  let result: PigeRunResult;
  // Le compte des annonces reçues est pris à la source, avant la porte commune.
  let received = 0;
  const counting: PigeSource = {
    ads: async (n, since) => {
      const ads = await source.ads(n, since);
      received = ads.length;
      return ads;
    },
  };
  try {
    const r = await collector.collect(networkId, counting);
    result = { outcome: 'ok', reason: null, received, ...r };
  } catch (error) {
    const reason: PigeFailureReason = error instanceof PigeSourceError ? error.reason : 'autre';
    result = { outcome: 'panne', reason, received: 0, added: 0, noAgency: 0, outside: 0, unreadable: 0 };
  }
  const at = now().toISOString();
  await db.run(
    'INSERT INTO pige_runs (id, network_id, ran_at, outcome, received, added, no_agency, outside, unreadable, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), networkId, at, result.outcome, result.received, result.added, result.noAgency, result.outside, result.unreadable, result.reason],
  );
  if (result.outcome === 'panne') {
    await appendEvent(journal, { type: 'pige.panne', actor: 'system:pige', subject: `network:${networkId}`, data: { rule: 'R671', reason: result.reason } }, now);
  } else {
    await appendEvent(
      journal,
      { type: previous?.outcome === 'panne' ? 'pige.retablie' : 'pige.relevee', actor: 'system:pige', subject: `network:${networkId}`, data: { rule: 'R671', received: result.received, added: result.added } },
      now,
    );
  }
  return result;
}

/** La tâche du planificateur : chaque jour à 6 h, seulement avec un fournisseur réglé pour ce réseau. */
export function pigeCollectJob(
  db: SqlDatabase,
  journal: JournalStore,
  collector: PigeCollector,
  provider: { networkId: string; source: PigeSource } | null,
  options: { now?: () => Date } = {},
): ScheduledJob {
  return {
    name: PIGE_COLLECT_JOB,
    hours: PIGE_COLLECT_HOURS,
    run: async () => {
      if (!provider) return;
      await runPigeCollect(db, journal, collector, provider.networkId, provider.source, options.now);
    },
  };
}

/** L'alerte de la pige : en panne au dernier passage, en retard d'un passage, ou jamais relevée ; null quand tout va. */
export type PigeAlert = 'panne' | 'en_retard' | 'jamais_relevee' | 'non_reglee';

export interface PigeCollectState {
  /** Vrai quand le fournisseur est réglé pour ce réseau. */
  configured: boolean;
  /** Les réglages qui manquent : à la direction seulement, vide pour un agent. */
  missing: PigeProviderSetting[];
  /** La dernière relève réussie, ou null. */
  lastCollectedAt: string | null;
  lastRun: { at: string; outcome: 'ok' | 'panne'; reason: PigeFailureReason | null; received: number; added: number } | null;
  alert: PigeAlert | null;
}

export type PigeCollectStateResult = { ok: true; value: PigeCollectState } | { ok: false; rule: 'R16'; code: 'role' };

/** L'état de la relève, lu par la direction et les agents du réseau [R671, R16]. */
export async function pigeCollectState(
  db: SqlDatabase,
  journal: JournalStore,
  viewer: Viewer,
  settings: PigeProviderSettings,
  now: () => Date = () => new Date(),
): Promise<PigeCollectStateResult> {
  if (viewer.role !== 'direction' && viewer.role !== 'agent') {
    await appendEvent(
      journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'pige_etat', code: 'role' } },
      now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }
  const missing = missingPigeSettings(settings);
  const configured = missing.length === 0 && (settings.networkId ?? '').trim() === viewer.networkId;
  const last = await db.first<{ ran_at: string; outcome: 'ok' | 'panne'; reason: PigeFailureReason | null; received: number; added: number }>(
    'SELECT ran_at, outcome, reason, received, added FROM pige_runs WHERE network_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1',
    [viewer.networkId],
  );
  const ok = await db.first<{ ran_at: string }>("SELECT ran_at FROM pige_runs WHERE network_id = ? AND outcome = 'ok' ORDER BY ran_at DESC, rowid DESC LIMIT 1", [viewer.networkId]);
  const lastCollectedAt = ok?.ran_at ?? null;
  let alert: PigeAlert | null = null;
  if (!configured) alert = 'non_reglee';
  else if (last?.outcome === 'panne') alert = 'panne';
  else if (!lastCollectedAt) alert = 'jamais_relevee';
  else if (now().getTime() - Date.parse(lastCollectedAt) > PIGE_LATE_AFTER_HOURS * HOUR) alert = 'en_retard';
  return {
    ok: true,
    value: {
      configured,
      missing: viewer.role === 'direction' ? missing : [],
      lastCollectedAt,
      lastRun: last ? { at: last.ran_at, outcome: last.outcome, reason: last.reason, received: Number(last.received), added: Number(last.added) } : null,
      alert,
    },
  };
}

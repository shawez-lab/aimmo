/**
 * L'agenda de l'agent relié pour de vrai au Worker (AU053) : Google Agenda, Outlook ou Apple, derrière les adaptateurs
 * de HX02 (`GoogleAgenda`, `OutlookAgenda`, `AppleAgenda`) et la synchronisation de V03 (`AgendaSync`).
 *
 * Les vrais agendas ne sont faits que si tout est rangé (H21, H53) : `AGENDA_MODE` vaut `reel`, le client OAuth de
 * Google (`AGENDA_GOOGLE_CLIENT_ID`, `AGENDA_GOOGLE_CLIENT_SECRET`) ou de Microsoft (`AGENDA_MICROSOFT_CLIENT_ID`,
 * `AGENDA_MICROSOFT_CLIENT_SECRET`, `AGENDA_MICROSOFT_TENANT`), et le secret `AGENDA_JETONS` : pour chaque agent qui a
 * donné son accord, un seul agenda, en JSON
 *   `{"<agent>":{"google":"<jeton de rafraîchissement>"}}`, `{"<agent>":{"outlook":"<jeton>"}}` ou
 *   `{"<agent>":{"apple":{"utilisateur":"…","motDePasse":"<mot de passe d'application>","calendrier":"https://…/"}}}`.
 * Une entrée mal formée, ou qui donne deux agendas, est écartée, jamais devinée ; un agent sans agenda relié n'est
 * jamais appelé chez un fournisseur [R702].
 *
 * Branché, l'agenda sert de deux façons :
 *   - à la réservation (site, assistant, espace client, et l'agent pour son client) : un événement occupé de l'agent
 *     refuse le créneau [R33] ; un agenda injoignable ferme la réservation (`agenda_indisponible`) plutôt que de
 *     risquer deux rendez-vous au même moment, et rien n'est réservé ;
 *   - au passage des quarts d'heure : ce que l'agent a déplacé ou annulé dans son agenda revient sur le rendez-vous, puis
 *     chaque rendez-vous est écrit une seule fois dans son agenda [R236]. Une panne est notée et reprise [R13].
 * Aucun jeton, aucun mot de passe ni aucune adresse ne va au journal : le nom de la panne seul.
 */
import { AgendaHttpError, AgendaSync, AppleAgenda, GoogleAgenda, OutlookAgenda, RendezVous, agendaConnection, type AgendaChanges, type AgendaEvent, type AgendaProvider, type AgendaWrite, type BusySource, type FetchFn, type JournalStore, type SqlDatabase } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';

export const AGENDA_PROVIDERS = ['google', 'outlook', 'apple'] as const;
export type AgendaProviderName = (typeof AGENDA_PROVIDERS)[number];

export interface AgendaEnv {
  AGENDA_MODE?: string | undefined;
  AGENDA_GOOGLE_CLIENT_ID?: string | undefined;
  AGENDA_GOOGLE_CLIENT_SECRET?: string | undefined;
  AGENDA_MICROSOFT_CLIENT_ID?: string | undefined;
  AGENDA_MICROSOFT_CLIENT_SECRET?: string | undefined;
  AGENDA_MICROSOFT_TENANT?: string | undefined;
  AGENDA_JETONS?: string | undefined;
}

/** Les agendas reliés des agents. */
export interface AgendaDirectory {
  /** Un seul fournisseur pour tout le Worker : il aiguille chaque agent vers son agenda ; sans agenda, rien n'est lu. */
  provider: AgendaProvider;
  /** L'agenda relié de l'agent, ou `null`. */
  of(agentId: string): AgendaProviderName | null;
  /** Les agents qui ont relié un agenda, dans l'ordre des identifiants. */
  agents(): string[];
}

type Connection =
  | { provider: 'google' | 'outlook'; refresh: string }
  | { provider: 'apple'; user: string; password: string; calendar: string };

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GOOGLE_CLIENT = /^[A-Za-z0-9-]{1,100}\.apps\.googleusercontent\.com$/;
const MS_CLIENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_TENANT = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/i;
const TOKEN = /^[\x21-\x7e]{10,4096}$/;
const APPLE_USER = /^[\x21-\x7e]{3,254}$/;
const APPLE_PASSWORD = /^[\x21-\x7e]{8,128}$/;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** L'adresse CalDAV du calendrier : https, sans identifiants ni paramètres, terminée par `/`. */
function calendarUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/')) return null;
  return u.toString();
}

function connectionOf(entry: unknown): Connection | null {
  if (!isObj(entry)) return null;
  const given = AGENDA_PROVIDERS.filter((p) => entry[p] !== undefined);
  // Un agent a un seul agenda relié : deux, et rien n'est deviné.
  if (given.length !== 1 || Object.keys(entry).length !== 1) return null;
  const provider = given[0]!;
  const v = entry[provider];
  if (provider === 'apple') {
    if (!isObj(v)) return null;
    const { utilisateur, motDePasse } = v;
    const calendar = calendarUrl(v.calendrier);
    if (typeof utilisateur !== 'string' || !APPLE_USER.test(utilisateur) || typeof motDePasse !== 'string' || !APPLE_PASSWORD.test(motDePasse) || !calendar) return null;
    return { provider, user: utilisateur, password: motDePasse, calendar };
  }
  return typeof v === 'string' && TOKEN.test(v.trim()) ? { provider, refresh: v.trim() } : null;
}

/** Les agendas de `AGENDA_JETONS`, un par agent ; une entrée mal formée est écartée, jamais devinée. */
export function parseAgendaConnections(raw: string | undefined): Map<string, Connection> {
  const out = new Map<string, Connection>();
  if (!raw || raw.trim() === '') return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isObj(data)) return out;
  for (const [agentId, entry] of Object.entries(data)) {
    if (!AGENT_ID.test(agentId)) continue;
    const c = connectionOf(entry);
    if (c) out.set(agentId, c);
  }
  return out;
}

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const msToken = (tenant: string): string => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
const MS_SCOPE = 'offline_access https://graph.microsoft.com/Calendars.ReadWrite';

/** Les jetons d'accès d'un fournisseur OAuth, un par agent, gardés jusqu'à une minute avant leur fin. */
class AccessTokens {
  private readonly cache = new Map<string, { token: string; until: number }>();
  constructor(
    private readonly http: FetchFn,
    private readonly url: string,
    private readonly client: { id: string; secret: string },
    private readonly scope: string | null,
    private readonly refresh: (agentId: string) => string | null,
    private readonly now: () => Date,
  ) {}

  async of(agentId: string): Promise<string> {
    const at = this.now().getTime();
    const hit = this.cache.get(agentId);
    if (hit && hit.until > at) return `Bearer ${hit.token}`;
    const refresh = this.refresh(agentId);
    if (!refresh) throw new AgendaHttpError(401);
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.client.id, client_secret: this.client.secret, refresh_token: refresh });
    if (this.scope) form.set('scope', this.scope);
    const r = await this.http(this.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!r.ok) throw new AgendaHttpError(r.status);
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      throw new AgendaHttpError(502);
    }
    const token = isObj(body) && typeof body.access_token === 'string' && body.access_token !== '' ? body.access_token : null;
    if (!token) throw new AgendaHttpError(502);
    const life = isObj(body) && typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    this.cache.set(agentId, { token, until: at + Math.max(0, life - 60) * 1000 });
    return `Bearer ${token}`;
  }
}

/** Le mot de passe d'application d'Apple, en authentification simple. */
function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return `Basic ${btoa(s)}`;
}

/** Aiguille chaque agent vers son agenda ; un agent sans agenda relié n'a aucun événement et n'est jamais écrit. */
class AgendaRouter implements AgendaProvider {
  constructor(private readonly byAgent: (agentId: string) => AgendaProvider | null) {}

  private need(agentId: string): AgendaProvider {
    const p = this.byAgent(agentId);
    if (!p) throw new AgendaHttpError(404);
    return p;
  }

  async events(agentId: string, from: Date, to: Date): Promise<AgendaEvent[]> {
    const p = this.byAgent(agentId);
    return p ? p.events(agentId, from, to) : [];
  }

  write(agentId: string, eventId: string | null, event: AgendaWrite): Promise<{ eventId: string }> {
    return this.need(agentId).write(agentId, eventId, event);
  }

  changes(agentId: string, cursor: string | null): Promise<AgendaChanges> {
    return this.need(agentId).changes(agentId, cursor);
  }
}

/** Les vrais agendas des agents, ou `null` tant que la mise en service n'est pas complète [R702]. */
export function agendasFromEnv(env: AgendaEnv, http: FetchFn, options: { now?: () => Date } = {}): AgendaDirectory | null {
  if (env.AGENDA_MODE !== 'reel') return null;
  const now = options.now ?? (() => new Date());
  const all = parseAgendaConnections(env.AGENDA_JETONS);
  const gId = env.AGENDA_GOOGLE_CLIENT_ID?.trim() ?? '';
  const gSecret = env.AGENDA_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const mId = env.AGENDA_MICROSOFT_CLIENT_ID?.trim() ?? '';
  const mSecret = env.AGENDA_MICROSOFT_CLIENT_SECRET?.trim() ?? '';
  const tenant = env.AGENDA_MICROSOFT_TENANT?.trim() || 'common';
  const googleReady = GOOGLE_CLIENT.test(gId) && gSecret !== '';
  const outlookReady = MS_CLIENT.test(mId) && mSecret !== '' && MS_TENANT.test(tenant);
  // Seuls les agendas dont le fournisseur est complet sont gardés.
  const connections = new Map([...all].filter(([, c]) => (c.provider === 'google' ? googleReady : c.provider === 'outlook' ? outlookReady : true)));
  if (connections.size === 0) return null;
  const refresh = (agentId: string): string | null => {
    const c = connections.get(agentId);
    return c && c.provider !== 'apple' ? c.refresh : null;
  };
  // Les jetons d'accès sont gardés d'un appel à l'autre pendant la vie du Worker.
  const googleTokens = googleReady ? new AccessTokens(http, GOOGLE_TOKEN, { id: gId, secret: gSecret }, null, refresh, now) : null;
  const outlookTokens = outlookReady ? new AccessTokens(http, msToken(tenant), { id: mId, secret: mSecret }, MS_SCOPE, refresh, now) : null;
  const googleAgenda = googleTokens ? new GoogleAgenda(agendaConnection(http, (a) => googleTokens.of(a))) : null;
  const outlookAgenda = outlookTokens ? new OutlookAgenda(agendaConnection(http, (a) => outlookTokens.of(a)), { now }) : null;
  const appleAgenda = new AppleAgenda(
    agendaConnection(http, async (a) => {
      const c = connections.get(a);
      if (c?.provider !== 'apple') throw new AgendaHttpError(401);
      return basic(c.user, c.password);
    }),
    async (a) => {
      const c = connections.get(a);
      if (c?.provider !== 'apple') throw new AgendaHttpError(404);
      return c.calendar;
    },
    { now },
  );
  const byAgent = (agentId: string): AgendaProvider | null => {
    const c = connections.get(agentId);
    if (!c) return null;
    return c.provider === 'google' ? googleAgenda : c.provider === 'outlook' ? outlookAgenda : appleAgenda;
  };
  return {
    provider: new AgendaRouter(byAgent),
    of: (agentId) => connections.get(agentId)?.provider ?? null,
    agents: () => [...connections.keys()].sort(),
  };
}

/** L'agenda n'a pas pu être lu au moment de réserver : rien n'est réservé. */
export class AgendaUnavailableError extends Error {
  override readonly name = 'AgendaUnavailableError';
  constructor() {
    super('Agenda de l’agent injoignable.');
  }
}

/**
 * Les événements occupés des agendas reliés, pour les créneaux et la réservation [R33, R702]. Un agenda injoignable
 * lève `AgendaUnavailableError`, noté au journal avec le nom de la panne seul [R13] ; jamais un créneau supposé libre.
 */
export function agendaBusyOf(db: SqlDatabase, journal: JournalStore, agendas: AgendaDirectory | null, now: () => Date): BusySource | undefined {
  if (!agendas) return undefined;
  const sync = new AgendaSync(db, journal, agendas.provider, new RendezVous(db, journal, { now }), { now, agents: () => agendas.agents() });
  const inner = sync.busySource();
  return {
    busy: async (agentId, from, to) => {
      try {
        return await inner.busy(agentId, from, to);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        await appendEvent(journal, { type: 'rdv.agenda.panne', actor: 'system:agenda', subject: `agent:${agentId}`, data: { step: 'busy', error: name } }, now);
        throw new AgendaUnavailableError();
      }
    },
  };
}

/** La synchronisation des agendas reliés, dans les deux sens ; `null` sans agenda relié. */
export function agendaSyncOf(db: SqlDatabase, journal: JournalStore, agendas: AgendaDirectory | null, now: () => Date): AgendaSync | null {
  if (!agendas) return null;
  let sync: AgendaSync;
  // Un déplacement venu de l'agenda passe par les mêmes règles qu'un décalage, l'agenda compris [R32, R33].
  const rdv = new RendezVous(db, journal, { now, agenda: { busy: (a, f, t) => sync.busySource().busy(a, f, t) } });
  sync = new AgendaSync(db, journal, agendas.provider, rdv, { now, agents: () => agendas.agents() });
  return sync;
}

/**
 * Le passage des quarts d'heure : ramener ce que chaque agent a changé dans son agenda, puis écrire ce qui doit l'être.
 * Une panne est déjà notée par la synchronisation ; elle n'arrête pas le reste du Worker [R13].
 */
export async function runAgendaPass(s: { db: SqlDatabase; journal: JournalStore; now: () => Date; agendas: AgendaDirectory | null }): Promise<'non_relie' | 'fait' | 'panne'> {
  const sync = agendaSyncOf(s.db, s.journal, s.agendas, s.now);
  if (!sync) return 'non_relie';
  try {
    await sync.run();
    return 'fait';
  } catch {
    return 'panne';
  }
}

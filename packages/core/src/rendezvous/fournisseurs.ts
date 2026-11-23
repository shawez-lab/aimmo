/**
 * L'agenda de l'agent chez Google, Outlook et Apple (HX02), derrière l'interface `AgendaProvider` de V03.
 *
 * Chaque adaptateur parle au service par `fetch`, avec l'en-tête d'autorisation que lui donne la connexion de l'agent
 * (jamais rangé ici, jamais écrit au journal). Les mêmes règles valent pour les trois [R236] :
 *   - un rendez-vous n'a jamais deux événements dans un agenda : l'identifiant de l'événement est tiré de la clé du
 *     rendez-vous (Google : identifiant choisi ; Apple : nom du fichier ; Outlook : `transactionId` et propriété cherchée
 *     avant toute création), si bien qu'une écriture reprise après une coupure retrouve l'événement déjà créé ;
 *   - l'agenda ne reçoit que l'heure, le type et l'intitulé sans nom ni coordonnée de `agendaTitle` ;
 *   - un rendez-vous annulé laisse son événement marqué annulé : AIMMO n'efface jamais rien dans l'agenda ;
 *   - un événement « disponible » de l'agent (transparent, libre) ne bloque aucun créneau.
 * Une réponse en erreur lève `AgendaHttpError`, dont seul le nom va au journal [R13].
 */
import { parisInstant } from './creneaux.ts';
import { AGENDA_KEY_PREFIX, type AgendaChanges, type AgendaEvent, type AgendaProvider, type AgendaWrite } from './agenda.ts';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export interface AgendaConnection {
  fetch: FetchFn;
  /** La valeur de l'en-tête `Authorization` pour l'agent (jeton OAuth, ou mot de passe d'application chez Apple). */
  authorization(agentId: string): Promise<string>;
}

/** La connexion d'un agent : son appel au service et la valeur de son en-tête d'autorisation (AU053). */
export const agendaConnection = (http: FetchFn, authorization: (agentId: string) => Promise<string>): AgendaConnection => ({ fetch: http, authorization });

/** Une réponse en erreur du service d'agenda : le statut seul, jamais le corps. */
export class AgendaHttpError extends Error {
  override readonly name = 'AgendaHttpError';
  constructor(readonly status: number) {
    super(`Agenda : réponse ${status}.`);
  }
}

const EPOCH = new Date(0);

async function call(c: AgendaConnection, agentId: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const headers = { ...init.headers, Authorization: await c.authorization(agentId) };
  return c.fetch(url, { ...init, headers });
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new AgendaHttpError(r.status);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Google Agenda (API Calendar v3)

const B32 = '0123456789abcdefghijklmnopqrstuv';

/** L'identifiant Google tiré de la clé : base32hex en minuscules, les seuls caractères que Google accepte. */
export function googleEventId(key: string): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of new TextEncoder().encode(key)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** La clé AIMMO d'un identifiant Google, ou `null` si l'événement n'a pas été créé par AIMMO. */
export function keyOfGoogleId(id: string): string | null {
  if (!/^[0-9a-v]+$/.test(id)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of id) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return text.startsWith(AGENDA_KEY_PREFIX) && googleEventId(text) === id ? text : null;
  } catch {
    return null;
  }
}

interface GoogleTime {
  dateTime?: string;
  date?: string;
}
interface GoogleItem {
  id: string;
  status?: string;
  transparency?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  extendedProperties?: { private?: Record<string, string> };
}
interface GooglePage {
  items?: GoogleItem[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

const googleTime = (t: GoogleTime | undefined): Date => {
  if (t?.dateTime) return new Date(t.dateTime);
  if (t?.date) return parisInstant(t.date, 0) ?? EPOCH;
  return EPOCH;
};

function fromGoogle(item: GoogleItem): AgendaEvent {
  return {
    id: item.id,
    start: googleTime(item.start),
    end: googleTime(item.end),
    // Supprimé par l'agent (`cancelled` chez Google), ou annulé par AIMMO (l'événement reste, marqué).
    cancelled: item.status === 'cancelled' || item.extendedProperties?.private?.['aimmo-etat'] === 'annule',
    // Un événement supprimé ne garde que son identifiant : la clé se relit dans l'identifiant choisi par AIMMO.
    key: item.extendedProperties?.private?.aimmo ?? keyOfGoogleId(item.id),
  };
}

export class GoogleAgenda implements AgendaProvider {
  private readonly base: string;
  constructor(
    private readonly c: AgendaConnection,
    options: { calendarId?: string; base?: string } = {},
  ) {
    this.base = `${options.base ?? 'https://www.googleapis.com/calendar/v3'}/calendars/${encodeURIComponent(options.calendarId ?? 'primary')}/events`;
  }

  private async pages(agentId: string, params: URLSearchParams): Promise<{ items: GoogleItem[]; syncToken: string | null }> {
    const items: GoogleItem[] = [];
    let pageToken: string | null = null;
    for (let i = 0; i < 100; i++) {
      const q = new URLSearchParams(params);
      if (pageToken) q.set('pageToken', pageToken);
      const page: GooglePage = await json<GooglePage>(await call(this.c, agentId, `${this.base}?${q}`));
      items.push(...(page.items ?? []));
      if (!page.nextPageToken) return { items, syncToken: page.nextSyncToken ?? null };
      pageToken = page.nextPageToken;
    }
    throw new AgendaHttpError(508);
  }

  async events(agentId: string, from: Date, to: Date): Promise<AgendaEvent[]> {
    const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', maxResults: '250' });
    const { items } = await this.pages(agentId, params);
    return items
      .filter((i) => i.status !== 'cancelled' && !(i.transparency === 'transparent' && !i.extendedProperties?.private?.aimmo))
      .map(fromGoogle);
  }

  async write(agentId: string, eventId: string | null, event: AgendaWrite): Promise<{ eventId: string }> {
    const own = googleEventId(event.key);
    // Chez Google, `status: cancelled` supprime l'événement : un rendez-vous annulé reste donc confirmé, libre et marqué.
    const body = {
      summary: event.cancelled ? `Annulé · ${event.title}` : event.title,
      start: { dateTime: event.start.toISOString() },
      end: { dateTime: event.end.toISOString() },
      status: 'confirmed',
      transparency: event.cancelled ? 'transparent' : 'opaque',
      extendedProperties: { private: { aimmo: event.key, 'aimmo-etat': event.cancelled ? 'annule' : 'actif' } },
    };
    const put = (id: string) =>
      call(this.c, agentId, `${this.base}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let r = await put(eventId ?? own);
    if (r.status === 404 || r.status === 410) {
      // Jamais écrit (ou disparu) : création sous l'identifiant tiré de la clé. Déjà là, il est repris, jamais doublé.
      r = await call(this.c, agentId, this.base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, id: own }) });
      if (r.status === 409) r = await put(own);
    }
    const saved = await json<GoogleItem>(r);
    return { eventId: saved.id };
  }

  async changes(agentId: string, cursor: string | null): Promise<AgendaChanges> {
    if (cursor) {
      try {
        const { items, syncToken } = await this.pages(agentId, new URLSearchParams({ syncToken: cursor, showDeleted: 'true', singleEvents: 'true', maxResults: '2500' }));
        return { events: items.map(fromGoogle), cursor: syncToken ?? cursor };
      } catch (error) {
        // Curseur périmé : Google demande une lecture complète.
        if (!(error instanceof AgendaHttpError && error.status === 410)) throw error;
      }
    }
    const { items, syncToken } = await this.pages(agentId, new URLSearchParams({ showDeleted: 'true', singleEvents: 'true', maxResults: '2500' }));
    if (!syncToken) throw new AgendaHttpError(502);
    return { events: items.map(fromGoogle), cursor: syncToken, complete: { from: null, to: null } };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Outlook (Microsoft Graph)

/** Les propriétés étendues posées par AIMMO sur l'événement Outlook : la clé, et l'état du rendez-vous. */
export const OUTLOOK_KEY_PROP = 'String {6f3c5e4a-2b1d-4c8e-9a7f-1d2e3f4a5b6c} Name aimmo';
export const OUTLOOK_STATE_PROP = 'String {6f3c5e4a-2b1d-4c8e-9a7f-1d2e3f4a5b6c} Name aimmo-etat';

interface GraphTime {
  dateTime: string;
  timeZone?: string;
}
interface GraphItem {
  id: string;
  isCancelled?: boolean;
  showAs?: string;
  start?: GraphTime;
  end?: GraphTime;
  singleValueExtendedProperties?: { id: string; value: string }[];
  '@removed'?: unknown;
}
interface GraphPage {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

// Les heures sont demandées en UTC (en-tête `Prefer`) ; Graph les rend sans suffixe.
const graphTime = (t: GraphTime | undefined): Date => (t?.dateTime ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`) : EPOCH);
const prop = (item: GraphItem, id: string): string | null => item.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === id.toLowerCase())?.value ?? null;

/** Un événement Graph présent ; un retrait (`@removed`) ne passe jamais ici sans avoir été relu (`confirmed`). */
function fromGraph(item: GraphItem): AgendaEvent {
  return {
    id: item.id,
    start: graphTime(item.start),
    end: graphTime(item.end),
    cancelled: item.isCancelled === true || prop(item, OUTLOOK_STATE_PROP) === 'annule',
    key: prop(item, OUTLOOK_KEY_PROP),
  };
}

const UTC = { Prefer: 'outlook.timezone="UTC"' };
const EXPAND = `singleValueExtendedProperties($filter=id eq '${OUTLOOK_KEY_PROP}' or id eq '${OUTLOOK_STATE_PROP}')`;

export class OutlookAgenda implements AgendaProvider {
  private readonly base: string;
  private readonly now: () => Date;
  constructor(
    private readonly c: AgendaConnection,
    options: { base?: string; now?: () => Date } = {},
  ) {
    this.base = options.base ?? 'https://graph.microsoft.com/v1.0/me';
    this.now = options.now ?? (() => new Date());
  }

  private async pages(agentId: string, first: string): Promise<{ items: GraphItem[]; delta: string | null }> {
    const items: GraphItem[] = [];
    let url: string | undefined = first;
    for (let i = 0; i < 100 && url; i++) {
      const page: GraphPage = await json<GraphPage>(await call(this.c, agentId, url, { headers: UTC }));
      items.push(...(page.value ?? []));
      if (page['@odata.deltaLink']) return { items, delta: page['@odata.deltaLink'] };
      url = page['@odata.nextLink'];
    }
    if (url) throw new AgendaHttpError(508);
    return { items, delta: null };
  }

  async events(agentId: string, from: Date, to: Date): Promise<AgendaEvent[]> {
    const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '100', $expand: EXPAND });
    const { items } = await this.pages(agentId, `${this.base}/calendarView?${q}`);
    return items.filter((i) => !(i.showAs === 'free' && prop(i, OUTLOOK_KEY_PROP) === null)).map(fromGraph).filter((e) => !e.cancelled);
  }

  private async findByKey(agentId: string, key: string): Promise<string | null> {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${OUTLOOK_KEY_PROP}' and ep/value eq '${key.replace(/'/g, "''")}')`;
    const page = await json<GraphPage>(await call(this.c, agentId, `${this.base}/events?${new URLSearchParams({ $filter: filter, $top: '1' })}`, { headers: UTC }));
    return page.value?.[0]?.id ?? null;
  }

  async write(agentId: string, eventId: string | null, event: AgendaWrite): Promise<{ eventId: string }> {
    const body = {
      subject: event.cancelled ? `Annulé · ${event.title}` : event.title,
      start: { dateTime: event.start.toISOString().slice(0, 19), timeZone: 'UTC' },
      end: { dateTime: event.end.toISOString().slice(0, 19), timeZone: 'UTC' },
      // Annulé : l'événement reste, libre et marqué ; Graph n'annule que les réunions avec invités.
      showAs: event.cancelled ? 'free' : 'busy',
      singleValueExtendedProperties: [
        { id: OUTLOOK_KEY_PROP, value: event.key },
        { id: OUTLOOK_STATE_PROP, value: event.cancelled ? 'annule' : 'actif' },
      ],
    };
    const patch = (id: string) =>
      call(this.c, agentId, `${this.base}/events/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (eventId) {
      const r = await patch(eventId);
      if (r.status !== 404) return { eventId: (await json<GraphItem>(r)).id };
    }
    const found = await this.findByKey(agentId, event.key);
    if (found) return { eventId: (await json<GraphItem>(await patch(found))).id };
    // `transactionId` : Graph ne crée pas deux fois l'événement d'une même clé, même si la réponse s'est perdue.
    const r = await call(this.c, agentId, `${this.base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, transactionId: event.key }) });
    return { eventId: (await json<GraphItem>(r)).id };
  }

  /**
   * Le curseur garde la fin de la fenêtre lue (`<fin>|<lien>`) : le lien de Graph garde pour toujours la fenêtre de sa
   * première lecture ; à moins de 60 jours de sa fin, une lecture complète repart sur une fenêtre neuve.
   */
  async changes(agentId: string, cursor: string | null): Promise<AgendaChanges> {
    const sep = cursor ? cursor.indexOf('|') : -1;
    const end = sep > 0 ? new Date(cursor!.slice(0, sep)) : null;
    const link = sep > 0 ? cursor!.slice(sep + 1) : null;
    if (link && end && end.getTime() - this.now().getTime() > 60 * 86_400_000) {
      try {
        const { items, delta } = await this.pages(agentId, link);
        return { events: await this.confirmed(agentId, items), cursor: `${end.toISOString()}|${delta ?? link}` };
      } catch (error) {
        // Lien périmé : Graph demande une lecture complète.
        if (!(error instanceof AgendaHttpError && error.status === 410)) throw error;
      }
    }
    const now = this.now().getTime();
    const from = new Date(now - 31 * 86_400_000);
    const to = new Date(now + 400 * 86_400_000);
    const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString() });
    const { items, delta } = await this.pages(agentId, `${this.base}/calendarView/delta?${q}`);
    if (!delta) throw new AgendaHttpError(502);
    return { events: await this.confirmed(agentId, items), cursor: `${to.toISOString()}|${delta}`, complete: { from, to } };
  }

  /**
   * Graph rend aussi `@removed` pour un événement qui sort de la fenêtre, sans être supprimé : chaque retrait est
   * vérifié en relisant l'événement, et seul un événement introuvable compte comme supprimé.
   */
  private async confirmed(agentId: string, items: GraphItem[]): Promise<AgendaEvent[]> {
    const out: AgendaEvent[] = [];
    for (const item of items) {
      if (item['@removed'] === undefined) {
        out.push(fromGraph(item));
        continue;
      }
      const r = await call(this.c, agentId, `${this.base}/events/${encodeURIComponent(item.id)}?${new URLSearchParams({ $expand: EXPAND })}`, { headers: UTC });
      if (r.status === 404 || r.status === 410) out.push({ id: item.id, start: EPOCH, end: EPOCH, cancelled: true, key: null });
      else out.push(fromGraph(await json<GraphItem>(r)));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Apple (iCloud, CalDAV)

const xmlText = (s: string): string =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&#13;/g, '\r')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const tag = (name: string): RegExp => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');

interface DavResponse {
  href: string;
  status: number;
  data: string | null;
}

/** Les réponses d'un `multistatus` : l'adresse, le statut, et le contenu iCalendar s'il y est. */
export function parseMultistatus(xml: string): { responses: DavResponse[]; syncToken: string | null } {
  const responses: DavResponse[] = [];
  const re = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let rest = xml;
  for (const m of xml.matchAll(re)) {
    const body = m[1] ?? '';
    rest = rest.replace(m[0], '');
    const href = tag('href').exec(body)?.[1]?.trim();
    if (!href) continue;
    // Seul le statut propre à la réponse (hors `propstat`) dit qu'une ressource n'existe plus.
    const own = body.replace(/<(?:[\w-]+:)?propstat\b[\s\S]*?<\/(?:[\w-]+:)?propstat>/gi, '');
    const status = Number(/HTTP\/[\d.]+\s+(\d{3})/.exec(own)?.[1] ?? 200);
    // Le contenu ne compte que dans un `propstat` en 200.
    const ok = [...body.matchAll(/<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)].map((p) => p[1] ?? '').filter((p) => /HTTP\/[\d.]+\s+200/.test(p));
    const data = ok.map((p) => tag('calendar-data').exec(p)?.[1]).find((d) => d !== undefined);
    responses.push({ href: xmlText(href), status, data: data ? xmlText(data.trim()) : null });
  }
  const token = tag('sync-token').exec(rest)?.[1]?.trim();
  return { responses, syncToken: token ? xmlText(token) : null };
}

type Props = Map<string, { params: string; value: string }>;

/** Les propriétés de chaque VEVENT, lignes dépliées : nom, paramètres, valeur. */
function vevents(ics: string): Props[] {
  const lines = ics.replace(/\r\n[ \t]|\n[ \t]/g, '').split(/\r?\n/);
  const all: Props[] = [];
  let out: Props | null = null;
  // Les composants imbriqués (VALARM) ont leurs propres propriétés : elles ne sont pas celles de l'événement.
  let nested = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      out = new Map();
      nested = 0;
    } else if (line === 'END:VEVENT') {
      if (out) all.push(out);
      out = null;
    } else if (out && /^BEGIN:/i.test(line)) nested++;
    else if (out && /^END:/i.test(line)) nested = Math.max(0, nested - 1);
    else if (out && nested === 0) {
      const m = /^([A-Z0-9-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
      if (m && !out.has(m[1]!.toUpperCase())) out.set(m[1]!.toUpperCase(), { params: m[2] ?? '', value: m[3] ?? '' });
    }
  }
  return all;
}
const vevent = (ics: string): Props | null => vevents(ics)[0] ?? null;

/** Une heure iCalendar : UTC (`Z`), sinon heure de Paris ; une date seule vaut minuit, heure de Paris. */
/**
 * Le fuseau d'une heure locale : celui de `TZID` s'il est un nom IANA connu, sinon Paris (un fuseau propre au
 * calendrier, décrit par un VTIMEZONE, n'est pas lu : les agents sont en France).
 */
function zoneOf(params: string): string {
  const tzid = /;TZID=("?)([^;:"]+)\1/i.exec(params)?.[2]?.trim();
  if (!tzid) return 'Europe/Paris';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tzid });
    return tzid;
  } catch {
    return 'Europe/Paris';
  }
}

/** L'heure murale d'un instant dans un fuseau, en millisecondes comme si c'était de l'UTC. */
function wallOf(t: number, zone: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  const v = (k: string) => Number(p.find((x) => x.type === k)?.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
}

/**
 * Un instant à une heure locale d'un fuseau, secondes comprises. Une heure qui n'existe pas (passage à l'heure d'été)
 * est prise au décalage d'avant ; une heure qui existe deux fois, à la première.
 */
function zoned(date: string, minutes: number, seconds: number, zone: string): Date | null {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60, seconds);
  if (Number.isNaN(wall)) return null;
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) candidates.add(wall - (wallOf(probe, zone) - probe));
  const exact = [...candidates].filter((t) => wallOf(t, zone) === wall).sort((a, b) => a - b);
  return new Date(exact[0] ?? wall - (wallOf(wall - 86_400_000, zone) - (wall - 86_400_000)));
}

function icsTime(p: { params: string; value: string } | undefined): Date {
  if (!p) return EPOCH;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(p.value.trim());
  if (!m) return EPOCH;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return parisInstant(date, 0) ?? EPOCH;
  if (m[7]) return new Date(`${date}T${m[4]}:${m[5]}:${m[6]}Z`);
  return zoned(date, Number(m[4]) * 60 + Number(m[5]), Number(m[6]), zoneOf(p.params)) ?? EPOCH;
}

/** Une durée iCalendar (`PT1H`, `P1D`, `P2W`) : jours de calendrier, et le reste en millisecondes ; `null` si illisible. */
function icsDuration(value: string): { days: number; ms: number } | null {
  const v = value.trim();
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m || /P$|T$/.test(v)) return null;
  const [w, d, h, min, sec] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  return { days: w * 7 + d, ms: ((h * 60 + min) * 60 + sec) * 1000 };
}

const addDaysTo = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * La fin d'un VEVENT (RFC 5545, 3.6.1 et 3.3.6) : DTEND, sinon DTSTART plus DURATION, les jours comptés en jours de
 * calendrier à l'heure de Paris (changement d'heure compris) ; sans l'un ni l'autre, une date seule dure un jour, une
 * heure ne dure rien.
 */
function icsEnd(e: Map<string, { params: string; value: string }>): Date {
  const start = icsTime(e.get('DTSTART'));
  if (e.get('DTEND')) return icsTime(e.get('DTEND'));
  const raw = e.get('DTSTART')?.value.trim() ?? '';
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  const duration = e.get('DURATION') ? icsDuration(e.get('DURATION')!.value) : m && m[4] === undefined ? { days: 1, ms: 0 } : null;
  if (!duration || !m) return start;
  let base: Date;
  if (duration.days === 0 || m[7]) base = new Date(start.getTime() + duration.days * 86_400_000);
  else {
    // Heure locale ou date seule : on avance la date, puis on reprend la même heure de Paris.
    const minutes = m[4] === undefined ? 0 : Number(m[4]) * 60 + Number(m[5]);
    const zone = m[4] === undefined ? 'Europe/Paris' : zoneOf(e.get('DTSTART')!.params);
    base = zoned(addDaysTo(`${m[1]}-${m[2]}-${m[3]}`, duration.days), minutes, m[4] === undefined ? 0 : Number(m[6]), zone) ?? start;
  }
  return new Date(base.getTime() + duration.ms);
}

const icsEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Le fichier iCalendar d'un rendez-vous : l'heure, le type, la clé ; rien d'autre. */
export function appleIcs(event: AgendaWrite, stamp: Date, uid: string = appleUid(event.key)): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AIMMO//Agenda//FR',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(stamp)}`,
    `DTSTART:${icsStamp(event.start)}`,
    `DTEND:${icsStamp(event.end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    `X-AIMMO-KEY:${icsEscape(event.key)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** L'UID et le nom du fichier tirés de la clé : seuls lettres, chiffres et tirets. */
export const appleUid = (key: string): string => key.replace(/[^A-Za-z0-9-]/g, '-');

function fromProps(href: string, e: Props): AgendaEvent {
  const key = e.get('X-AIMMO-KEY')?.value.replace(/\\(.)/g, '$1') ?? null;
  return {
    id: href,
    start: icsTime(e.get('DTSTART')),
    end: icsEnd(e),
    cancelled: e.get('STATUS')?.value.toUpperCase() === 'CANCELLED',
    key,
  };
}

function fromIcs(href: string, ics: string): AgendaEvent | null {
  const e = vevent(ics);
  return e ? fromProps(href, e) : null;
}

const isFree = (e: Props): boolean => e.get('TRANSP')?.value.toUpperCase() === 'TRANSPARENT';

export class AppleAgenda implements AgendaProvider {
  private readonly now: () => Date;
  constructor(
    private readonly c: AgendaConnection,
    /** L'adresse CalDAV du calendrier de l'agent, terminée par `/`. */
    private readonly calendarUrl: (agentId: string) => Promise<string>,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async report(agentId: string, body: string): Promise<{ responses: DavResponse[]; syncToken: string | null }> {
    const r = await call(this.c, agentId, await this.calendarUrl(agentId), { method: 'REPORT', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body });
    if (r.status !== 207) throw new AgendaHttpError(r.status);
    return parseMultistatus(await r.text());
  }

  async events(agentId: string, from: Date, to: Date): Promise<AgendaEvent[]> {
    const { responses } = await this.report(
      agentId,
      `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${icsStamp(from)}" end="${icsStamp(to)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icsStamp(from)}" end="${icsStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
    );
    const out: AgendaEvent[] = [];
    for (const r of responses) {
      if (r.status !== 200 || !r.data) continue;
      // Développée par le serveur (`expand`), une série rend chaque occurrence comme un VEVENT à part.
      for (const props of vevents(r.data)) {
        const e = fromProps(r.href, props);
        if (e.cancelled || (isFree(props) && !e.key)) continue;
        if (e.start < to && e.end > from) out.push(e);
      }
    }
    return out;
  }

  async write(agentId: string, eventId: string | null, event: AgendaWrite): Promise<{ eventId: string }> {
    const base = await this.calendarUrl(agentId);
    const own = new URL(`${appleUid(event.key)}.ics`, base).pathname;
    const href = eventId ?? own;
    // Un rendez-vous décalé reprend l'événement de celui qu'il remplace : la ressource garde son UID (RFC 4791,
    // `no-uid-conflict`), tiré de son nom de fichier.
    const uid = eventId ? decodeURIComponent(href.split('/').pop() ?? '').replace(/\.ics$/, '') || appleUid(event.key) : appleUid(event.key);
    // Le nom du fichier vient de la clé : la même écriture reprise remplace le fichier, sans jamais le doubler.
    const r = await call(this.c, agentId, new URL(href, base).toString(), { method: 'PUT', headers: { 'Content-Type': 'text/calendar; charset=utf-8' }, body: appleIcs(event, this.now(), uid) });
    if (!r.ok) throw new AgendaHttpError(r.status);
    return { eventId: href };
  }

  async changes(agentId: string, cursor: string | null): Promise<AgendaChanges> {
    const body = (token: string | null) =>
      `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:sync-token>${token ?? ''}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><c:calendar-data/></d:prop></d:sync-collection>`;
    let page: { responses: DavResponse[]; syncToken: string | null };
    let complete = cursor === null;
    try {
      page = await this.report(agentId, body(cursor));
    } catch (error) {
      // Jeton périmé (RFC 6578, `valid-sync-token`) : lecture complète.
      if (!(cursor && error instanceof AgendaHttpError && (error.status === 403 || error.status === 409))) throw error;
      page = await this.report(agentId, body(null));
      complete = true;
    }
    if (!page.syncToken) throw new AgendaHttpError(502);
    const base = await this.calendarUrl(agentId);
    const events: AgendaEvent[] = [];
    for (const r of page.responses) {
      if (r.status === 404 || r.status === 410) {
        events.push({ id: r.href, start: EPOCH, end: EPOCH, cancelled: true, key: null });
        continue;
      }
      let data = r.data;
      if (!data) {
        const got = await call(this.c, agentId, new URL(r.href, base).toString());
        if (got.status === 404) {
          events.push({ id: r.href, start: EPOCH, end: EPOCH, cancelled: true, key: null });
          continue;
        }
        if (!got.ok) throw new AgendaHttpError(got.status);
        data = await got.text();
      }
      const e = fromIcs(r.href, data);
      if (e) events.push(e);
    }
    return { events, cursor: page.syncToken, ...(complete ? { complete: { from: null, to: null } } : {}) };
  }
}

// Faux serveurs d'agenda pour HX02 : Google Agenda, Outlook (Microsoft Graph) et Apple (CalDAV), en mémoire.
// Chacun ne fait que ce que les adaptateurs demandent, avec les comportements qui comptent : identifiants choisis,
// conflits, curseurs de changements, suppressions qui ne gardent que l'identifiant. Tout est inventé.
import type { AgendaProvider, FetchFn } from '../src/index.ts';
import { AppleAgenda, GoogleAgenda, OutlookAgenda } from '../src/index.ts';

export interface Live {
  id: string;
  key: string | null;
  start: Date;
  end: Date;
  cancelled: boolean;
  title: string | null;
}

export interface Request {
  method: string;
  url: string;
  body: string;
  auth: string | null;
}

export interface FakeServer {
  name: string;
  provider(now: () => Date): AgendaProvider;
  agentAdd(start: Date, end: Date, options?: { free?: boolean; parisLocal?: boolean; weekly?: boolean }): string;
  agentMove(id: string, start: Date, end: Date): void;
  agentRemove(id: string): void;
  live(): Live[];
  requests: Request[];
  /** Le prochain appel répond ce statut. */
  failNext: number | null;
  /** Le prochain appel qui écrit est fait, mais sa réponse se perd. */
  loseNextWrite: boolean;
  /** Le curseur en cours est périmé. */
  expireCursor(): void;
}

export const TOKEN = 'Bearer jeton-essai-secret-0123456789';
const conn = (fetch: FetchFn) => ({ fetch, authorization: async () => TOKEN });
const res = (status: number, body?: unknown, type = 'application/json'): Response =>
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });

abstract class Base {
  requests: Request[] = [];
  failNext: number | null = null;
  loseNextWrite = false;
  protected seq = 0;
  protected n = 0;
  protected expiredBelow = -1;

  expireCursor(): void {
    this.expiredBelow = this.seq + 1;
  }

  readonly fetch: FetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    this.requests.push({ method, url, body: init.body ?? '', auth: init.headers?.Authorization ?? null });
    if (this.failNext !== null) {
      const status = this.failNext;
      this.failNext = null;
      return res(status, { error: 'panne' });
    }
    const r = await this.handle(method, new URL(url), init.body ?? '');
    if (method !== 'GET' && method !== 'REPORT' && this.loseNextWrite && r.status < 300) {
      this.loseNextWrite = false;
      throw new Error('réponse perdue');
    }
    return r;
  };

  protected abstract handle(method: string, url: URL, body: string): Promise<Response>;
}

// ---------------------------------------------------------------------------------------------------------------------

interface GItem {
  id: string;
  status: string;
  transparency: string;
  summary: string | null;
  start: Date;
  end: Date;
  key: string | null;
  etat: string | null;
  seq: number;
}

class GoogleServer extends Base implements FakeServer {
  name = 'Google Agenda';
  readonly items = new Map<string, GItem>();
  private readonly prefix = '/calendar/v3/calendars/primary/events';

  provider(): AgendaProvider {
    return new GoogleAgenda(conn(this.fetch), { base: 'https://google.example.test/calendar/v3' });
  }

  private out(i: GItem, full: boolean) {
    // Un événement supprimé ne garde que son identifiant et son état, comme chez Google.
    if (!full && i.status === 'cancelled') return { id: i.id, status: 'cancelled' };
    return {
      id: i.id,
      status: i.status,
      transparency: i.transparency,
      summary: i.summary,
      start: { dateTime: i.start.toISOString() },
      end: { dateTime: i.end.toISOString() },
      ...(i.key ? { extendedProperties: { private: { aimmo: i.key, ...(i.etat ? { 'aimmo-etat': i.etat } : {}) } } } : {}),
    };
  }

  protected async handle(method: string, url: URL, body: string): Promise<Response> {
    if (!url.pathname.startsWith(this.prefix)) return res(404);
    const rest = decodeURIComponent(url.pathname.slice(this.prefix.length + 1));
    const q = url.searchParams;
    if (method === 'GET' && !rest) {
      const all = [...this.items.values()].sort((a, b) => a.seq - b.seq);
      const sync = q.get('syncToken');
      if (sync !== null) {
        const since = Number(sync.slice(1));
        if (since < this.expiredBelow) return res(410, { error: 'gone' });
        return this.page(all.filter((i) => i.seq > since).map((i) => this.out(i, false)), q, true);
      }
      if (q.get('timeMin')) {
        const from = new Date(q.get('timeMin')!);
        const to = new Date(q.get('timeMax')!);
        return this.page(all.filter((i) => i.status !== 'cancelled' && i.start < to && i.end > from).map((i) => this.out(i, true)), q, false);
      }
      return this.page(all.filter((i) => q.get('showDeleted') === 'true' || i.status !== 'cancelled').map((i) => this.out(i, false)), q, true);
    }
    const b = body ? (JSON.parse(body) as { id?: string; summary: string; status: string; transparency: string; start: { dateTime: string }; end: { dateTime: string }; extendedProperties?: { private?: { aimmo?: string; 'aimmo-etat'?: string } } }) : null;
    const apply = (id: string) => {
      const item: GItem = { id, status: b!.status, transparency: b!.transparency, summary: b!.summary, start: new Date(b!.start.dateTime), end: new Date(b!.end.dateTime), key: b!.extendedProperties?.private?.aimmo ?? null, etat: b!.extendedProperties?.private?.['aimmo-etat'] ?? null, seq: ++this.seq };
      this.items.set(id, item);
      return res(200, this.out(item, true));
    };
    if (method === 'PUT' && rest) return this.items.has(rest) ? apply(rest) : res(404);
    if (method === 'POST' && !rest) {
      const id = b!.id ?? `x${++this.n}`;
      if (!/^[0-9a-v]{5,1024}$/.test(id)) return res(400);
      // Un identifiant déjà pris, même supprimé, est refusé.
      if (this.items.has(id)) return res(409);
      return apply(id);
    }
    return res(405);
  }

  private page(items: unknown[], q: URLSearchParams, sync: boolean): Response {
    // Deux événements par page, pour faire passer la lecture par plusieurs pages.
    const start = Number(q.get('pageToken') ?? 0);
    const slice = items.slice(start, start + 2);
    const more = start + 2 < items.length;
    return res(200, { items: slice, ...(more ? { nextPageToken: String(start + 2) } : sync ? { nextSyncToken: `s${this.seq}` } : {}) });
  }

  agentAdd(start: Date, end: Date, options: { free?: boolean } = {}): string {
    const id = `x${++this.n}`;
    this.items.set(id, { id, status: 'confirmed', transparency: options.free ? 'transparent' : 'opaque', summary: 'Perso', start, end, key: null, etat: null, seq: ++this.seq });
    return id;
  }
  agentMove(id: string, start: Date, end: Date): void {
    this.items.set(id, { ...this.items.get(id)!, start, end, seq: ++this.seq });
  }
  agentRemove(id: string): void {
    this.items.set(id, { ...this.items.get(id)!, status: 'cancelled', seq: ++this.seq });
  }
  live(): Live[] {
    // `cancelled` chez Google veut dire supprimé : l'événement n'est plus dans l'agenda de l'agent.
    return [...this.items.values()].filter((i) => i.status !== 'cancelled').map((i) => ({ id: i.id, key: i.key, start: i.start, end: i.end, cancelled: i.etat === 'annule', title: i.summary }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------

interface OItem {
  id: string;
  subject: string | null;
  showAs: string;
  start: Date;
  end: Date;
  props: { id: string; value: string }[];
  removed: boolean;
  transactionId: string | null;
  seq: number;
}

const graphDate = (d: Date) => ({ dateTime: `${d.toISOString().slice(0, 19)}.0000000`, timeZone: 'UTC' });

class OutlookServer extends Base implements FakeServer {
  name = 'Outlook';
  readonly items = new Map<string, OItem>();
  private readonly root = 'https://graph.example.test/v1.0/me';

  provider(now: () => Date): AgendaProvider {
    return new OutlookAgenda(conn(this.fetch), { base: this.root, now });
  }

  private out(i: OItem, props: boolean) {
    return { id: i.id, subject: i.subject, showAs: i.showAs, isCancelled: false, start: graphDate(i.start), end: graphDate(i.end), ...(props ? { singleValueExtendedProperties: i.props } : {}) };
  }

  protected async handle(method: string, url: URL, body: string): Promise<Response> {
    const path = url.pathname.replace('/v1.0/me', '');
    const q = url.searchParams;
    const all = [...this.items.values()].sort((a, b) => a.seq - b.seq);
    if (method === 'GET' && path === '/calendarView') {
      const from = new Date(q.get('startDateTime')!);
      const to = new Date(q.get('endDateTime')!);
      return res(200, { value: all.filter((i) => !i.removed && i.start < to && i.end > from).map((i) => this.out(i, true)) });
    }
    if (method === 'GET' && path === '/calendarView/delta') {
      const token = q.get('$deltatoken');
      const since = token === null ? 0 : Number(token);
      if (token !== null && since < this.expiredBelow) return res(410, { error: 'syncStateNotFound' });
      // La lecture des changements ne rend pas les propriétés étendues ; une suppression ne garde que l'identifiant.
      // Le lien garde pour toujours la fenêtre de la première lecture, comme chez Graph.
      const from = new Date(q.get('startDateTime')!);
      const to = new Date(q.get('endDateTime')!);
      // Un événement changé hors de la fenêtre revient en `@removed`, même s'il existe encore, comme chez Graph.
      const inside = (i: OItem) => i.start < to && i.end > from;
      const value = all
        .filter((i) => i.seq > since && (token !== null ? true : !i.removed && inside(i)))
        .map((i) => (i.removed || !inside(i) ? { id: i.id, '@removed': { reason: i.removed ? 'deleted' : 'changed' } } : this.out(i, false)));
      const window = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString() });
      return res(200, { value, '@odata.deltaLink': `${this.root}/calendarView/delta?${window}&$deltatoken=${this.seq}` });
    }
    if (method === 'GET' && path === '/events') {
      const value = /ep\/value eq '((?:[^']|'')*)'\)$/.exec(q.get('$filter') ?? '')?.[1]?.replace(/''/g, "'");
      return res(200, { value: all.filter((i) => !i.removed && i.props.some((p) => p.id.endsWith('Name aimmo') && p.value === value)).slice(0, 1).map((i) => this.out(i, true)) });
    }
    const b = body ? (JSON.parse(body) as { subject: string; showAs: string; start: { dateTime: string }; end: { dateTime: string }; singleValueExtendedProperties: { id: string; value: string }[]; transactionId?: string }) : null;
    if (method === 'POST' && path === '/events') {
      const same = b!.transactionId ? all.find((i) => !i.removed && i.transactionId === b!.transactionId) : undefined;
      if (same) return res(201, this.out(same, true));
      const id = `AAMk${++this.n}`;
      const item: OItem = { id, subject: b!.subject, showAs: b!.showAs, start: new Date(`${b!.start.dateTime}Z`), end: new Date(`${b!.end.dateTime}Z`), props: b!.singleValueExtendedProperties, removed: false, transactionId: b!.transactionId ?? null, seq: ++this.seq };
      this.items.set(id, item);
      return res(201, this.out(item, true));
    }
    const m = /^\/events\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      const item = this.items.get(decodeURIComponent(m[1]!));
      return item && !item.removed ? res(200, this.out(item, true)) : res(404);
    }
    if (method === 'PATCH' && m) {
      const before = this.items.get(decodeURIComponent(m[1]!));
      if (!before || before.removed) return res(404);
      const item: OItem = { ...before, subject: b!.subject, showAs: b!.showAs, start: new Date(`${b!.start.dateTime}Z`), end: new Date(`${b!.end.dateTime}Z`), props: b!.singleValueExtendedProperties, seq: ++this.seq };
      this.items.set(item.id, item);
      return res(200, this.out(item, true));
    }
    return res(405);
  }

  agentAdd(start: Date, end: Date, options: { free?: boolean } = {}): string {
    const id = `AAMk${++this.n}`;
    this.items.set(id, { id, subject: 'Perso', showAs: options.free ? 'free' : 'busy', start, end, props: [], removed: false, transactionId: null, seq: ++this.seq });
    return id;
  }
  agentMove(id: string, start: Date, end: Date): void {
    this.items.set(id, { ...this.items.get(id)!, start, end, seq: ++this.seq });
  }
  agentRemove(id: string): void {
    this.items.set(id, { ...this.items.get(id)!, removed: true, seq: ++this.seq });
  }
  live(): Live[] {
    return [...this.items.values()]
      .filter((i) => !i.removed)
      .map((i) => ({
        id: i.id,
        key: i.props.find((p) => p.id.endsWith('Name aimmo'))?.value ?? null,
        start: i.start,
        end: i.end,
        cancelled: i.props.find((p) => p.id.endsWith('Name aimmo-etat'))?.value === 'annule',
        title: i.subject,
      }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------

interface AFile {
  path: string;
  ics: string;
  start: Date;
  end: Date;
  deleted: boolean;
  weekly: boolean;
  seq: number;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const parisLocal = (d: Date) => {
  const p = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return `${v('year')}${v('month')}${v('day')}T${v('hour')}${v('minute')}${v('second')}`;
};
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class AppleServer extends Base implements FakeServer {
  name = 'Apple';
  readonly files = new Map<string, AFile>();
  static readonly CAL = 'https://caldav.example.test/1234/calendars/home/';
  private readonly calPath = new URL(AppleServer.CAL).pathname;

  provider(now: () => Date): AgendaProvider {
    return new AppleAgenda(conn(this.fetch), async () => AppleServer.CAL, { now });
  }

  private icsOf(start: Date, end: Date, options: { free?: boolean; parisLocal?: boolean; weekly?: boolean }, uid: string): string {
    const time = (d: Date) => (options.parisLocal ? `;TZID=Europe/Paris:${parisLocal(d)}` : `:${stamp(d)}`);
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTART${time(start)}`, `DTEND${time(end)}`, ...(options.weekly ? ['RRULE:FREQ=WEEKLY'] : []), 'SUMMARY:Perso', `TRANSP:${options.free ? 'TRANSPARENT' : 'OPAQUE'}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  }

  /** Avec `expand`, une série devient ses occurrences de la fenêtre, en UTC, comme le fait un serveur CalDAV. */
  private expanded(f: AFile, from: Date, to: Date): AFile {
    const week = 7 * 86_400_000;
    const span = f.end.getTime() - f.start.getTime();
    const out: string[] = [];
    for (let t = f.start.getTime(); t < to.getTime(); t += week) {
      if (t + span <= from.getTime()) continue;
      out.push('BEGIN:VEVENT', `UID:${f.path}`, `RECURRENCE-ID:${stamp(new Date(t))}`, `DTSTART:${stamp(new Date(t))}`, `DTEND:${stamp(new Date(t + span))}`, 'SUMMARY:Perso', 'END:VEVENT');
    }
    return { ...f, ics: ['BEGIN:VCALENDAR', 'VERSION:2.0', ...out, 'END:VCALENDAR', ''].join('\r\n') };
  }

  private resp(f: AFile): string {
    // Les noms d'espaces varient d'un serveur à l'autre ; le contenu est échappé, une fois en CDATA.
    if (f.deleted) return `<D:response><D:href>${f.path}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
    const data = f.seq % 2 === 0 ? `<![CDATA[${f.ics}]]>` : escapeXml(f.ics);
    return `<D:response><D:href>${f.path}</D:href><D:propstat><D:prop><D:getetag>"${f.seq}"</D:getetag><C:calendar-data>${data}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  protected async handle(method: string, url: URL, body: string): Promise<Response> {
    const all = [...this.files.values()].sort((a, b) => a.seq - b.seq);
    const ms = (inner: string, token?: string) =>
      res(207, `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}${token ? `<D:sync-token>${token}</D:sync-token>` : ''}</D:multistatus>`, 'application/xml');
    if (method === 'REPORT' && url.pathname === this.calPath) {
      if (body.includes('calendar-query')) {
        const m = /start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(body)!;
        const d = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
        const from = d(m[1]!);
        const to = d(m[2]!);
        const expand = body.includes('expand');
        // Sans `expand`, une série est rendue telle quelle : son DTSTART est la première occurrence.
        return ms(
          all
            .filter((f) => !f.deleted && f.start < to && (f.weekly || f.end > from))
            .map((f) => this.resp(f.weekly && expand ? this.expanded(f, from, to) : f))
            .join(''),
        );
      }
      const token = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(body)?.[1] ?? '';
      const since = token ? Number(token.replace('tok-', '')) : 0;
      if (token && since < this.expiredBelow) return res(403, '<error><valid-sync-token/></error>', 'application/xml');
      return ms(all.filter((f) => f.seq > since && (token !== '' || !f.deleted)).map((f) => this.resp(f)).join(''), `tok-${this.seq}`);
    }
    if (!url.pathname.startsWith(this.calPath) || !url.pathname.endsWith('.ics')) return res(404);
    if (method === 'GET') {
      const f = this.files.get(url.pathname);
      return f && !f.deleted ? res(200, f.ics, 'text/calendar') : res(404);
    }
    if (method === 'PUT') {
      const start = /DTSTART:(\d{8}T\d{6}Z)/.exec(body)![1]!;
      const end = /DTEND:(\d{8}T\d{6}Z)/.exec(body)![1]!;
      const d = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
      const existed = this.files.has(url.pathname) && !this.files.get(url.pathname)!.deleted;
      this.files.set(url.pathname, { path: url.pathname, ics: body, start: d(start), end: d(end), deleted: false, weekly: false, seq: ++this.seq });
      return res(existed ? 204 : 201);
    }
    return res(405);
  }

  agentAdd(start: Date, end: Date, options: { free?: boolean; parisLocal?: boolean; weekly?: boolean } = {}): string {
    const path = `${this.calPath}agent-${++this.n}.ics`;
    this.files.set(path, { path, ics: this.icsOf(start, end, options, `agent-${this.n}`), start, end, deleted: false, weekly: options.weekly ?? false, seq: ++this.seq });
    return path;
  }
  agentMove(id: string, start: Date, end: Date): void {
    const f = this.files.get(id)!;
    const ics = f.ics.replace(/DTSTART[^\r\n]*/, `DTSTART:${stamp(start)}`).replace(/DTEND[^\r\n]*/, `DTEND:${stamp(end)}`);
    this.files.set(id, { ...f, ics, start, end, seq: ++this.seq });
  }
  agentRemove(id: string): void {
    this.files.set(id, { ...this.files.get(id)!, deleted: true, seq: ++this.seq });
  }
  live(): Live[] {
    return [...this.files.values()]
      .filter((f) => !f.deleted)
      .map((f) => ({
        id: f.path,
        key: /X-AIMMO-KEY:([^\r\n]*)/.exec(f.ics)?.[1]?.replace(/\\(.)/g, '$1') ?? null,
        start: f.start,
        end: f.end,
        cancelled: /STATUS:CANCELLED/.test(f.ics),
        title: /SUMMARY:([^\r\n]*)/.exec(f.ics)?.[1] ?? null,
      }));
  }
}

export const SERVERS: (() => FakeServer)[] = [() => new GoogleServer(), () => new OutlookServer(), () => new AppleServer()];

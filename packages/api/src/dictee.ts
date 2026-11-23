/**
 * BR100 · La création à la voix (HX06), par l'API de l'application de l'agent :
 *
 *   POST /v1/dictee/lecture      { dictation, appointmentId? } : chaque champ lu avec sa phrase ; rien n'est rangé [R260, R261]
 *   POST /v1/dictee/validation   { requestId, dictation, readAt, appointmentId?, keep, report? } : la validation d'un geste
 *
 * Seul un agent dicte, pour lui-même : un autre rôle est refusé avant que le corps soit lu, et la couche métier écrit
 * ce refus au journal [R16]. La dictée n'est jamais écrite au journal [R13] : elle ne revient que dans la lecture, à
 * l'agent qui l'a envoyée. Aucun message ne part au contact dicté ; seul le compte rendu d'une visite, validé, part au
 * vendeur par le contrôle central, en mode essai [R26].
 */
import {
  ComptesRendus,
  FicheClient,
  FicheUnique,
  INTEREST_LEVELS,
  NouveauBien,
  RendezVous,
  Visites,
  dictee,
  type Acces,
  type JournalStore,
  type ReportWriter,
  type SqlDatabase,
  type Viewer,
  type VisitReport,
} from '@aimmo/core';
import { AgendaUnavailableError, agendaBusyOf, type AgendaDirectory } from './agenda-reel.ts';

/** Une dictée de 5 000 caractères, accents et échappements compris, et ce qui l'accompagne. */
export const MAX_DICTEE_BODY_BYTES = 32_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const READ_FIELDS = new Set(['dictation', 'appointmentId']);
const VALIDATE_FIELDS = new Set(['requestId', 'dictation', 'readAt', 'appointmentId', 'keep', 'report']);

export interface DicteeServices {
  db: SqlDatabase;
  acces: Acces;
  journal: JournalStore;
  now: () => Date;
  /** L'IA qui rédige le compte rendu d'une visite d'après la dictée (BR103), la même que celle de l'écran de la visite ; absente : aucun compte rendu proposé. */
  reportWriter?: ReportWriter | null;
  /** AU053 · les agendas reliés des agents (H21, H53) : la dictée vérifie et réserve ses créneaux avec eux [R33, R702]. */
  agendas?: AgendaDirectory | null;
}

export interface DicteeRoute {
  method: 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: DicteeServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const failure = (code: string): Response => json(400, { ok: false, rule: null, code });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_DICTEE_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Le compte rendu tel que l'agent le valide : seulement la forme connue, le contenu est relu par la couche métier [R52, R260]. */
function reportOf(value: unknown): VisitReport | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const list = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 8 && x.every((s) => typeof s === 'string' && s.length <= 200);
  if (typeof r.opinion !== 'string' || r.opinion.length > 1000 || !list(r.strengths) || !list(r.reservations)) return false;
  if (typeof r.interest !== 'string' || !(INTEREST_LEVELS as readonly string[]).includes(r.interest) || typeof r.readyToOffer !== 'boolean') return false;
  return { opinion: r.opinion, strengths: r.strengths, reservations: r.reservations, interest: r.interest as VisitReport['interest'], readyToOffer: r.readyToOffer };
}

/** `appointmentId` : absent ou nul, sinon un identifiant ; `false` quand il est mal formé. */
function appointmentOf(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && ID.test(value) ? value : false;
}

type Refusal = { ok: false; rule: string | null; code: string; keys?: string[]; kept?: unknown; freeSlots?: string[] };

/** Un refus de la couche métier : seulement ce qu'il dit à l'agent, jamais un autre champ qu'elle aurait porté. */
function refused(r: Refusal): Response {
  const body = {
    ok: false,
    rule: r.rule ?? null,
    code: r.code,
    ...(Array.isArray(r.keys) ? { keys: r.keys } : {}),
    ...(r.kept ? { kept: r.kept } : {}),
    ...(Array.isArray(r.freeSlots) ? { freeSlots: r.freeSlots } : {}),
  };
  if (r.rule === 'R16') return json(r.code === 'unknown' ? 404 : 403, body);
  if (r.rule === null && /^(bad|invalid)_/.test(r.code)) return json(400, body);
  if (r.code === 'unknown') return json(404, body);
  // AU053 : l'agenda relié injoignable ; ce qui est déjà rangé est nommé dans `kept` [R702].
  if (r.code === 'agenda_indisponible') return json(503, body);
  return json(409, body);
}

/** La création à la voix, avec la même prise de rendez-vous pour vérifier le créneau et le réserver [R32, R261]. */
function voix(s: DicteeServices): dictee.Dictee {
  const store = new FicheClient(s.db, { now: s.now });
  const fiche = new FicheUnique(s.db, store, { now: s.now });
  const agenda = agendaBusyOf(s.db, s.journal, s.agendas ?? null, s.now);
  const rendezVous = new RendezVous(s.db, s.journal, { now: s.now, ...(agenda ? { agenda } : {}) });
  const visites = new Visites(s.db, s.journal, s.acces, { now: s.now, rendezVous });
  const comptes = new ComptesRendus(s.db, s.journal, visites, { now: s.now, ...(s.reportWriter ? { writer: s.reportWriter } : {}) });
  const biens = new NouveauBien(s.db, s.acces, s.journal, { now: s.now });
  return new dictee.Dictee(s.db, s.journal, { acces: s.acces, store, fiche, biens, rendezVous, visites, comptes }, { now: s.now });
}

/**
 * Le rôle d'abord, avant le corps : la couche métier refuse tout autre rôle que l'agent et l'écrit au journal [R16].
 * Une dictée vide ne sert qu'à porter ce refus : elle n'est jamais lue.
 */
function agentOnly(run: (s: DicteeServices, viewer: Viewer, request: Request) => Promise<Response>): DicteeRoute['handle'] {
  return async (s, viewer, _params, request) => {
    if (viewer.role !== 'agent') {
      const r = await voix(s).prepare(viewer, { dictation: '' });
      return r.ok ? json(500, { ok: false, rule: null, code: 'internal' }) : refused(r);
    }
    try {
      return await run(s, viewer, request);
    } catch (error) {
      // L'agenda relié de l'agent n'a pas pu être lu : rien n'est réservé, l'agent le sait [R702].
      if (error instanceof AgendaUnavailableError) return json(503, { ok: false, rule: 'R702', code: 'agenda_indisponible' });
      throw error;
    }
  };
}

export function dicteeRoutes(): DicteeRoute[] {
  return [
    {
      method: 'POST',
      pattern: /^\/dictee\/lecture$/,
      name: 'dictee.lecture',
      handle: agentOnly(async (s, viewer, request) => {
        const body = await readJson(request);
        if (!body) return failure('invalid_body');
        if (Object.keys(body).some((k) => !READ_FIELDS.has(k))) return failure('unexpected_field');
        const { dictation } = body;
        if (typeof dictation !== 'string' || dictation.trim() === '' || dictation.length > dictee.DICTATION_MAX_CHARS) return failure('invalid_dictation');
        const appointmentId = appointmentOf(body.appointmentId);
        if (appointmentId === false) return failure('invalid_appointment');
        const r = await voix(s).prepare(viewer, { dictation, appointmentId });
        if (!r.ok) return refused(r);
        return json(200, { ok: true, mode: 'essai', sent: false, data: { draft: r.draft, readAt: r.readAt, report: r.report } });
      }),
    },
    {
      method: 'POST',
      pattern: /^\/dictee\/validation$/,
      name: 'dictee.validation',
      handle: agentOnly(async (s, viewer, request) => {
        const body = await readJson(request);
        if (!body) return failure('invalid_body');
        if (Object.keys(body).some((k) => !VALIDATE_FIELDS.has(k))) return failure('unexpected_field');
        const { requestId, dictation, readAt, keep } = body;
        if (typeof dictation !== 'string' || dictation.trim() === '' || dictation.length > dictee.DICTATION_MAX_CHARS) return failure('invalid_dictation');
        if (typeof requestId !== 'string' || typeof readAt !== 'string') return failure('invalid_request');
        if (typeof keep !== 'object' || keep === null || Array.isArray(keep)) return failure('invalid_keep');
        const appointmentId = appointmentOf(body.appointmentId);
        if (appointmentId === false) return failure('invalid_appointment');
        const report = reportOf(body.report);
        if (report === false) return failure('invalid_report');
        const r = await voix(s).validate(viewer, { requestId, dictation, readAt, appointmentId, keep: keep as dictee.DictationValidation['keep'], report });
        if (!r.ok) return refused(r);
        const { ok: _ok, ...data } = r;
        return json(200, { ok: true, mode: 'essai', sent: false, data });
      }),
    },
  ];
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { SqlDatabase } from '@aimmo/core';
import type { DraftExcerpt } from '../../core/src/avant-contrat/index.ts';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, clés, projet de compromis, montants et dates. Aucune vraie personne, aucun vrai bien.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-br89-alex-aaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-br89-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-br89-dir-ddddddddddddddddddddddddddd' };
type Who = keyof typeof KEYS;
// Mercredi 10 mars 2027, 10 h à Paris.
const WED_10H = new Date('2027-03-10T09:00:00.000Z');

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Un PDF d'une page par contenu (`null` : une page sans texte, comme un scan), police Helvetica en WinAnsi. */
function pdf(contents: (string | null)[]): Uint8Array {
  const kids = contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const streams: string[] = [];
  contents.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push('');
    streams[objs.length - 1] = c === null ? 'q 100 0 0 100 0 0 cm Q' : c;
  });
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    const data = streams[i];
    out += data === undefined ? `${i + 1} 0 obj\n${o}\nendobj\n` : `${i + 1} 0 obj\n<< /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
  });
  const at = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return enc(out);
}

const lines = (...ls: string[]) => `BT /F1 12 Tf 72 760 Td ${ls.map((l) => `(${l}) Tj`).join(' 0 -16 Td ')} ET`;
const PROJET = pdf([
  lines('COMPROMIS DE VENTE'),
  lines('PRIX', 'La vente est consentie moyennant le prix de 205 000,00 euros.'),
  null,
  lines('CONDITIONS SUSPENSIVES', "Condition suspensive d'obtention d'un prêt de 150 000 euros sur une durée de 20 ans.", "L'acquéreur devra justifier de l'obtention du prêt au plus tard le 30 avril 2027."),
]);
/** Le même projet, un chiffre changé : même allure, autre fichier. */
const AUTRE = pdf([
  lines('COMPROMIS DE VENTE'),
  lines('PRIX', 'La vente est consentie moyennant le prix de 215 000,00 euros.'),
  null,
  lines('CONDITIONS SUSPENSIVES', "Condition suspensive d'obtention d'un prêt de 150 000 euros sur une durée de 20 ans.", "L'acquéreur devra justifier de l'obtention du prêt au plus tard le 30 avril 2027."),
]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Le stockage des pièces inventé : il range ce qu'on y dépose et dit seulement si une référence y est. */
function fakePieces() {
  const refs = new Set<string>();
  return { refs, has: async (ref: string) => refs.has(ref), upload: async (key: string) => void refs.add(key) };
}

type Reply = { status: number; body: { ok: boolean; rule?: string | null; code?: string; message?: string; data?: any } };

async function setup(over: Partial<ApiConfig> = {}, withPieces = true) {
  const t = await setupDossier('appartement');
  await t.startCompromis();
  t.setClock(WED_10H);
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.agent.userId }, sam: { role: 'agent', userId: t.sam.userId }, direction: { role: 'direction', userId: t.direction.userId } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const pieces = fakePieces();
  const config: ApiConfig = { db: t.db as SqlDatabase, apiKeys, mode: 'essai', now: t.now, ...(withPieces ? { pieces } : {}), ...over };
  const http = async (who: Who | null, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const raw = body instanceof Uint8Array;
    const r = await handleRequest(
      new Request(`${ORIGIN}/v1/dossiers/${t.fileId}${path}`, {
        method,
        headers: { ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      }),
      config,
    );
    return { status: r.status, body: (await r.json()) as Reply['body'] };
  };
  /** Le projet déposé au dossier par la route même de M10, `POST …/preuves`, avec son empreinte. */
  const deposit = async (bytes: Uint8Array): Promise<string> => {
    const r = await http('alex', 'POST', '/preuves', bytes, { 'content-type': 'application/pdf', 'x-aimmo-sha256': sha(bytes), 'content-length': String(bytes.length) });
    if (r.status !== 200) throw new Error(`dépôt refusé : ${r.status} ${r.body.code}`);
    return r.body.data.ref as string;
  };
  const prelire = (who: Who, bytes: Uint8Array, ref: string) => http(who, 'POST', `/avant-contrat/pdf?documentRef=${encodeURIComponent(ref)}`, bytes, { 'content-type': 'application/pdf' });
  const journalText = async () => JSON.stringify(await t.db.all('SELECT * FROM journal'));
  return { t, http, deposit, prelire, pieces, journalText };
}

describeWithSqlite('BR89 · l’avant-contrat branché à l’API', () => {
  it('les routes sont servies sous /v1/dossiers/<id>/avant-contrat, clé exigée', async () => {
    const s = await setup();
    expect((await s.http(null, 'GET', '/avant-contrat')).status).toBe(401);
    const state = await s.http('alex', 'GET', '/avant-contrat');
    expect(state).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('sans stockage des pièces : 503, rien n’est lu', async () => {
    const s = await setup({}, false);
    const r = await s.http('alex', 'POST', '/avant-contrat/note', { depositEur: 10000 });
    expect(r).toMatchObject({ status: 503, body: { code: 'pieces_not_configured' } });
    expect(await s.t.db.first('SELECT 1 FROM journal WHERE type = ?', ['avant_contrat.note'])).toBeNull();
  });

  it('[R510, R511, R12] note rangée, projet déposé par …/preuves puis prélu sous sa référence ; sans lecteur, tout est à lire', async () => {
    const s = await setup();
    const note = await s.http('alex', 'POST', '/avant-contrat/note', { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15' });
    expect(note).toMatchObject({ status: 200, body: { ok: true, data: { version: 1, terms: { priceEur: 205000, depositEur: 10000 } } } });
    const ref = await s.deposit(PROJET);
    const r = await s.prelire('alex', PROJET, ref);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ documentRef: ref, pageCount: 4, pagesToRead: [3] });
    expect(r.body.data.reading.source).toBe('manuel');
    expect(r.body.data.reading.proposal.priceEur).toBeNull();
    expect(r.body.data.reading.toRead).toContain('prix');
    // La prélecture ne range rien ; le projet ne l'est que par …/projet.
    expect(await s.t.db.first('SELECT 1 FROM notary_drafts WHERE file_id = ?', [s.t.fileId])).toBeNull();
  });

  it('Jamais vu : par l’API en service, un autre PDF sous la même référence est refusé, rien n’est prélu', async () => {
    const seen: DraftExcerpt[][] = [];
    const s = await setup({ avantContrat: { reader: { read: async (e: DraftExcerpt[]) => (seen.push(e), null) } } });
    const ref = await s.deposit(PROJET);
    const r = await s.prelire('alex', AUTRE, ref);
    expect(r).toMatchObject({ status: 409, body: { code: 'not_the_deposited_file' } });
    expect(seen.length).toBe(0);
  });

  it('[R511] avec un lecteur inventé passé par `avantContrat`, le prix retrouvé sur sa page est proposé', async () => {
    const seen: DraftExcerpt[][] = [];
    const exact = { priceEur: { value: 205000, page: 2 }, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }], loanDeadline: { value: '2027-04-30', page: 4 }, deedBy: null, deposit: null };
    const s = await setup({ avantContrat: { reader: { read: async (e: DraftExcerpt[]) => (seen.push(e), exact) } } });
    const ref = await s.deposit(PROJET);
    const r = await s.prelire('alex', PROJET, ref);
    expect(r.status).toBe(200);
    expect(r.body.data.reading.source).toBe('ia');
    expect(r.body.data.reading.proposal.priceEur).toEqual({ value: 205000, page: 2 });
    expect(seen.length).toBe(1);
  });

  it('[R16] un autre agent est refusé au journal, rien n’est prélu ; la direction lit l’état', async () => {
    const s = await setup();
    const ref = await s.deposit(PROJET);
    const before = (await s.journalText()).split('acces.refuse').length;
    expect(await s.prelire('sam', PROJET, ref)).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await s.http('sam', 'POST', '/avant-contrat/note', { depositEur: 10000 })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect((await s.journalText()).split('acces.refuse').length).toBeGreaterThanOrEqual(before + 2);
    expect(await s.http('direction', 'POST', '/avant-contrat/note', { depositEur: 10000 })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await s.http('direction', 'GET', '/avant-contrat')).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('docs/API.md décrit les routes de l’avant-contrat', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('## Avant-contrat et projet du notaire'));
    expect(section.length).toBeGreaterThan(40);
    for (const path of ['/note', '/projet', '/dates', '/depot', '/prelecture', '/pdf?documentRef=', '…/preuves', 'not_the_deposited_file', 'pieces_not_configured']) expect(section).toContain(path);
  });
});

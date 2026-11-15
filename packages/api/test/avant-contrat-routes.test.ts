import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
import type { DraftExcerpt } from '../../core/src/avant-contrat/index.ts';
import { PDF_TEXT_REFUSAL_TEXT } from '../../core/src/documents/texte-pdf.ts';
import { DepotsDossier } from '../../core/src/dossiers/depot.ts';
import { MAX_PROJET_PDF_BYTES, avantContratRoutes, type AvantContratServices } from '../src/avant-contrat.ts';
import { PROOF, setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Projets de compromis, montants, dates et PDF inventés, écrits à la main : aucune vraie personne, aucun vrai bien.
// Mercredi 10 mars 2027, 10 h à Paris.
const WED_10H = new Date('2027-03-10T09:00:00.000Z');

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Un PDF d'une page par contenu (`null` : une page sans texte, comme un scan), police Helvetica en WinAnsi. */
function pdf(contents: (string | null)[]): Uint8Array {
  const kids = contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const streams: string[] = [];
  contents.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push('');
    streams[objs.length - 1] = c === null ? 'q 100 0 0 100 0 0 cm Q' : c;
  });
  const parts: Uint8Array[] = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objs.forEach((o, i) => {
    offsets.push(at);
    const data = streams[i];
    const chunk = data === undefined ? enc(`${i + 1} 0 obj\n${o}\nendobj\n`) : enc(`${i + 1} 0 obj\n<< /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`);
    parts.push(chunk);
    at += chunk.length;
  });
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(enc(x));
  return concat(parts);
}

const lines = (...ls: string[]) => `BT /F1 12 Tf 72 760 Td ${ls.map((l) => `(${l}) Tj`).join(' 0 -16 Td ')} ET`;

const PROJET = pdf([
  lines('COMPROMIS DE VENTE'),
  lines('PRIX', 'La vente est consentie moyennant le prix de 205 000,00 euros.'),
  null,
  lines('CONDITIONS SUSPENSIVES', "Condition suspensive d'obtention d'un prêt de 150 000 euros sur une durée de 20 ans.", "L'acquéreur devra justifier de l'obtention du prêt au plus tard le 30 avril 2027."),
]);
/** Le même projet, une virgule changée : même allure, autre fichier. */
const AUTRE = pdf([
  lines('COMPROMIS DE VENTE'),
  lines('PRIX', 'La vente est consentie moyennant le prix de 215 000,00 euros.'),
  null,
  lines('CONDITIONS SUSPENSIVES', "Condition suspensive d'obtention d'un prêt de 150 000 euros sur une durée de 20 ans.", "L'acquéreur devra justifier de l'obtention du prêt au plus tard le 30 avril 2027."),
]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function setup(o: { reader?: (e: DraftExcerpt[]) => Promise<unknown> } = {}) {
  const t = await setupDossier('appartement');
  await t.startCompromis();
  t.setClock(WED_10H);
  t.storage.refs.add(PROOF);
  const seen: DraftExcerpt[][] = [];
  const services: AvantContratServices = {
    db: t.db,
    journal: t.journal,
    now: t.now,
    pieces: t.storage,
    ...(o.reader
      ? {
          reader: {
            read: async (e: DraftExcerpt[]) => {
              seen.push(e);
              return o.reader!(e);
            },
          },
        }
      : {}),
  };
  const routes = avantContratRoutes();
  let bodyRead = 0;
  const route = (method: 'GET' | 'POST', path: string) => {
    const r = routes.find((x) => x.method === method && x.pattern.test(path));
    if (!r) throw new Error(`pas de route ${method} ${path}`);
    return { r, params: path.match(r.pattern)!.slice(1) };
  };
  const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { ok: boolean; code?: string; rule?: string | null; message?: string; data?: any } });
  /** Un corps qui compte ses lectures : un refus de droits ne doit jamais le lire [R16]. */
  const counted = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>(
      {
        pull(c) {
          bodyRead++;
          c.enqueue(bytes);
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
  const post = async (viewer: Viewer, path: string, body: unknown, query = '', type = 'application/json') => {
    const { r, params } = route('POST', path);
    const bytes = body instanceof Uint8Array ? body : enc(unescape(encodeURIComponent(JSON.stringify(body ?? {}))));
    const request = new Request(`https://api.example.test/v1${path}${query}`, { method: 'POST', body: counted(bytes), headers: { 'content-type': type }, duplex: 'half' } as RequestInit);
    return answer(await r.handle(services, viewer, params, request));
  };
  const get = async (viewer: Viewer, path: string) => {
    const { r, params } = route('GET', path);
    return answer(await r.handle(services, viewer, params, new Request(`https://api.example.test/v1${path}`)));
  };
  /** Le projet déposé au dossier comme par `POST …/preuves` : rangé au stockage, son empreinte au journal. */
  const deposit = async (bytes: Uint8Array, fileId = t.fileId, viewer = t.agent) => {
    const store = { put: async (key: string) => void t.storage.refs.add(key) };
    const r = await new DepotsDossier(t.db, t.acces, store, t.journal, { now: t.now }).deposit(viewer, fileId, {
      kind: 'preuve',
      contentType: 'application/pdf',
      sha256: sha(bytes),
      declaredSize: bytes.length,
      read: async () => bytes,
    });
    if (!r.ok) throw new Error(r.code);
    return r.value.ref;
  };
  const journalText = async () => JSON.stringify(await t.db.all('SELECT * FROM journal'));
  const base = `/dossiers/${t.fileId}/avant-contrat`;
  const compliance = { role: 'compliance', userId: 'c-1', networkId: t.agent.networkId } as Viewer;
  return { ...t, post, get, deposit, seen, journalText, base, compliance, bodyRead: () => bodyRead };
}

/** Ce qu'un lecteur exact rendrait du projet ci-dessus. */
const EXACT = {
  priceEur: { value: 205000, page: 2 },
  conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
  loanDeadline: { value: '2027-04-30', page: 4 },
  deedBy: null,
  deposit: null,
};

describeWithSqlite('RC54 · le projet du notaire servi par l’API, prélu depuis le PDF déposé', () => {
  it('[R510, R511] note, projet et état servis ; les différences viennent de la couche métier', async () => {
    const t = await setup();
    const note = await t.post(t.agent, `${t.base}/note`, { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15' });
    expect(note).toMatchObject({ status: 200, body: { ok: true, data: { version: 1, terms: { priceEur: 205000, depositEur: 10000 } } } });
    const ref = await t.deposit(PROJET);
    const projet = await t.post(t.agent, `${t.base}/projet`, {
      documentRef: ref,
      priceEur: { value: 210000, page: 2 },
      conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
      loanDeadline: { value: '2027-04-30', page: 4 },
      deedBy: { value: '2027-06-15', page: 7 },
      deposit: { eur: 10000, holder: 'notaire', page: 5 },
    });
    expect(projet.status).toBe(200);
    expect(projet.body.data.differences).toEqual([expect.objectContaining({ field: 'prix', page: 2 })]);
    for (const viewer of [t.agent, t.direction, t.compliance]) {
      const etat = await t.get(viewer, t.base);
      expect(etat.status).toBe(200);
      expect(etat.body.data.draft.documentRef).toBe(ref);
      expect(etat.body.data.texts.length).toBe(1);
    }
    // Un projet sans note : la couche métier le refuse.
    const t2 = await setup();
    expect(await t2.post(t2.agent, `${t2.base}/projet`, { documentRef: PROOF })).toMatchObject({ status: 409, body: { code: 'no_brief' } });
    expect(await t.post(t.agent, `${t.base}/note`, 'pas un objet')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
  });

  it('[R512, R513] dépôt reçu par un autre que le notaire : 409 ; dates avant la signature du compromis : 409', async () => {
    const t = await setup();
    await t.post(t.agent, `${t.base}/note`, { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15' });
    expect(await t.post(t.agent, `${t.base}/depot`, { amountEur: 10000, receivedBy: 'agence', receivedOn: '2027-03-09', proofRef: PROOF })).toMatchObject({ status: 409, body: { rule: 'R512', code: 'notary_only' } });
    const ok = await t.post(t.agent, `${t.base}/depot`, { amountEur: 10000, receivedBy: 'notaire', receivedOn: '2027-03-09', proofRef: PROOF });
    expect(ok).toMatchObject({ status: 200, body: { data: { receivedEur: 10000, status: 'recu' } } });
    expect(await t.post(t.agent, `${t.base}/dates`, {})).toMatchObject({ status: 409, body: { code: 'no_draft' } });
    await t.post(t.agent, `${t.base}/projet`, {
      documentRef: await t.deposit(PROJET),
      priceEur: { value: 205000, page: 2 },
      conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
      loanDeadline: { value: '2027-04-30', page: 4 },
      deedBy: { value: '2027-06-15', page: 7 },
      deposit: { eur: 10000, holder: 'notaire', page: 5 },
    });
    expect(await t.post(t.agent, `${t.base}/dates`, {})).toMatchObject({ status: 409, body: { rule: 'R513', code: 'compromis_not_signed' } });
  });

  it('[R511, R12] le PDF déposé est lu sans IA puis prélu sous sa référence ; la page sans texte est dite en mots', async () => {
    const t = await setup();
    const ref = await t.deposit(PROJET);
    const r = await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${ref}`, 'application/pdf');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ documentRef: ref, pageCount: 4, pagesToRead: [3], pagesToReadText: 'La page 3 n’a pas pu être lue : lisez-la vous-même.' });
    // Sans lecteur IA : rien n'est proposé, tout est à lire [R12].
    expect(r.body.data.reading.source).toBe('manuel');
    expect(r.body.data.reading.proposal.priceEur).toBeNull();
    expect(r.body.data.reading.toRead).toContain('prix');
    // Rien n'est rangé par la prélecture.
    expect(await t.db.first('SELECT 1 FROM notary_drafts WHERE file_id = ?', [t.fileId])).toBeNull();
  });

  it('[R511] avec un lecteur inventé, le prix retrouvé sur sa page est proposé ; un prix absent de la page ne l’est pas', async () => {
    const t = await setup({ reader: async () => EXACT });
    const ref = await t.deposit(PROJET);
    const r = await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${ref}`, 'application/pdf');
    expect(r.status).toBe(200);
    expect(r.body.data.reading.source).toBe('ia');
    expect(r.body.data.reading.proposal.priceEur).toEqual({ value: 205000, page: 2 });
    expect(r.body.data.reading.proposal.loanDeadline).toEqual({ value: '2027-04-30', page: 4 });
    expect(t.seen.length).toBe(1);
    const t2 = await setup({ reader: async () => ({ ...EXACT, priceEur: { value: 210000, page: 2 } }) });
    const ref2 = await t2.deposit(PROJET);
    const r2 = await t2.post(t2.agent, `${t2.base}/pdf`, PROJET, `?documentRef=${ref2}`, 'application/pdf');
    expect(r2.body.data.reading.proposal.priceEur).toBeNull();
    expect(r2.body.data.reading.toRead).toContain('prix');
  });

  it('Jamais vu : un autre PDF que celui déposé sous cette référence est refusé, rien n’est prélu', async () => {
    const t = await setup({ reader: async () => EXACT });
    const ref = await t.deposit(PROJET);
    const r = await t.post(t.agent, `${t.base}/pdf`, AUTRE, `?documentRef=${ref}`, 'application/pdf');
    expect(r).toMatchObject({ status: 409, body: { code: 'not_the_deposited_file' } });
    expect(r.body.message).toContain('n’est pas celui déposé');
    expect(t.seen.length).toBe(0);
    // Une référence rangée au stockage mais jamais déposée à ce dossier.
    const loose = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
    t.storage.refs.add(loose);
    expect(await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${loose}`, 'application/pdf')).toMatchObject({ status: 409, body: { code: 'not_deposited' } });
    // Une référence déposée à un autre dossier n'est pas celle de ce dossier.
    const other = await setup({ reader: async () => EXACT });
    const theirs = await other.deposit(PROJET);
    t.storage.refs.add(theirs);
    expect(await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${theirs}`, 'application/pdf')).toMatchObject({ status: 409, body: { code: 'not_deposited' } });
    expect(t.seen.length).toBe(0);
    const log = await t.journalText();
    expect(log).not.toContain('avant_contrat.prelecture');
  });

  it('pas un PDF, type de corps autre, corps trop gros, référence mal formée : refus en mots, rien prélu', async () => {
    const t = await setup({ reader: async () => EXACT });
    const ref = await t.deposit(PROJET);
    expect(await t.post(t.agent, `${t.base}/pdf`, PROJET, '', 'application/pdf')).toMatchObject({ status: 400, body: { code: 'bad_document' } });
    expect(await t.post(t.agent, `${t.base}/pdf`, PROJET, '?documentRef=preuves/projet.pdf', 'application/pdf')).toMatchObject({ status: 400, body: { code: 'bad_document' } });
    expect(await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${ref.replace(/\.pdf$/, '.jpg')}`, 'application/pdf')).toMatchObject({ status: 400, body: { code: 'bad_document' } });
    expect(await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${ref}`, 'application/octet-stream')).toMatchObject({ status: 415, body: { code: 'not_pdf_body' } });
    const big = new Uint8Array(MAX_PROJET_PDF_BYTES + 1);
    expect(await t.post(t.agent, `${t.base}/pdf`, big, `?documentRef=${ref}`, 'application/pdf')).toMatchObject({ status: 413, body: { code: 'too_large' } });
    // Un PDF abîmé, déposé tel quel : son empreinte tient, sa lecture est refusée en mots, jamais une exception.
    const broken = enc('%PDF-1.7\nun fichier abime, sans objet ni table\n%%EOF\n');
    const refBroken = await t.deposit(broken);
    const r = await t.post(t.agent, `${t.base}/pdf`, broken, `?documentRef=${refBroken}`, 'application/pdf');
    expect(r.status).toBe(422);
    expect(r.body.message).toBe(PDF_TEXT_REFUSAL_TEXT[r.body.code as keyof typeof PDF_TEXT_REFUSAL_TEXT]);
    expect(t.seen.length).toBe(0);
  });

  it('[R16] autre agent, direction en écriture, dossier inconnu : refus au journal, le corps jamais lu', async () => {
    const t = await setup();
    const ref = await t.deposit(PROJET);
    expect((await t.post(t.sam, `${t.base}/pdf`, PROJET, `?documentRef=${ref}`, 'application/pdf')).status).toBe(403);
    expect(await t.post(t.direction, `${t.base}/pdf`, PROJET, `?documentRef=${ref}`, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect(await t.post(t.direction, `${t.base}/note`, { depositEur: 10000 })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.post(t.compliance, `${t.base}/projet`, {})).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect((await t.post(t.agent, '/dossiers/inconnu/avant-contrat/pdf', PROJET, `?documentRef=${ref}`, 'application/pdf')).status).toBe(404);
    expect(t.bodyRead()).toBe(0);
    expect((await t.get(t.sam, t.base)).status).toBe(403);
    expect(await t.journalText()).toContain('acces.refuse');
  });

  it('[R13] la prélecture n’écrit au journal ni le texte, ni un montant, ni une date, ni l’empreinte une seconde fois', async () => {
    const t = await setup({ reader: async () => EXACT });
    const ref = await t.deposit(PROJET);
    const before = (await t.db.all('SELECT * FROM journal')).length;
    expect((await t.post(t.agent, `${t.base}/pdf`, PROJET, `?documentRef=${ref}`, 'application/pdf')).status).toBe(200);
    const added = JSON.stringify((await t.db.all('SELECT * FROM journal')).slice(before));
    expect(added).toContain('avant_contrat.prelecture');
    for (const leak of [sha(PROJET), '205000', '205 000', '2027-04-30', 'COMPROMIS', 'consentie']) expect(added).not.toContain(leak);
  });

  it('la prélecture sur le texte des pages fourni reste servie, rien n’est rangé', async () => {
    const t = await setup({ reader: async () => EXACT });
    const ref = await t.deposit(PROJET);
    const pages = ['COMPROMIS DE VENTE', 'PRIX\nLa vente est consentie moyennant le prix de 205 000,00 euros.', '', "L'acquéreur devra justifier de l'obtention du prêt au plus tard le 30 avril 2027. Condition suspensive d'obtention d'un prêt de 150 000 euros sur une durée de 20 ans."];
    const r = await t.post(t.agent, `${t.base}/prelecture`, { documentRef: ref, pages });
    expect(r.status).toBe(200);
    expect(r.body.data.proposal.priceEur).toEqual({ value: 205000, page: 2 });
    expect(await t.post(t.agent, `${t.base}/prelecture`, { documentRef: ref, pages: [] })).toMatchObject({ status: 400, body: { code: 'bad_pages' } });
    expect(await t.db.first('SELECT 1 FROM notary_drafts WHERE file_id = ?', [t.fileId])).toBeNull();
  });
});

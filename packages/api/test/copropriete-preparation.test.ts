import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { DOCUMENT_KINDS, TOPICS } from '../../core/src/documents/copropriete-urbanisme.ts';
import {
  COPRO_DOC_TOO_BIG,
  COPRO_KIND_ORDER,
  COPRO_MANUAL,
  COPRO_NO_DOC,
  COPRO_OFFLINE,
  COPRO_PDF_FAILED,
  COPRO_PDF_TWICE,
  COPRO_PREP_BUSY,
  COPRO_PREP_FAILED,
  COPRO_PREP_MAX_BYTES,
  COPRO_PREP_ROLE,
  COPRO_PREP_STOPPED,
  COPRO_REJECTED,
  COPRO_SENTENCES_ROOM,
  COPRO_TOO_BIG,
  COPRO_TOPIC_ORDER,
  COPROPRIETE_SCRIPT,
} from '../app/copropriete.ts';
import { MAX_COPROPRIETE_BODY_BYTES } from '../src/copropriete.ts';
import { FakeElement } from './fake-dom.ts';

// BR90. Tout est inventé : dossier, documents, phrases, adresse, montants.
type Res = { ok?: boolean; status?: number; body?: unknown; offline?: boolean; gone?: boolean };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const REF_A = `sha256:${'a'.repeat(64)}`;
const REF_B = `sha256:${'b'.repeat(64)}`;
const PV = {
  kind: 'pv_assemblee',
  ref: REF_A,
  pages: ['Feuille de présence.', 'Résolution 5 : ravalement de la façade voté pour 42 000 €, travaux à finir le 30/09/2027.'],
  meetingDay: '2027-02-10',
};
const FICHE = { kind: 'fiche_synthetique', ref: REF_B, pages: ['Charges courantes : budget voté de 18 000 € pour l’exercice.'] };
const SENTENCE = { topic: 'travaux_votes', text: 'Le ravalement de la façade est voté pour 42 000 €.', document: 0, page: 2, quote: 'ravalement de la façade voté pour 42 000 €', works: { amountEur: 42000 } };
const ok = (data: unknown): Res => ({ ok: true, status: 200, body: { ok: true, mode: 'essai', data } });
const no = (status: number, code: string, message?: string): Res => ({ ok: false, status, body: { ok: false, rule: null, code, ...(message ? { message } : {}) } });
const read = (document: unknown, sentences: unknown[] = [], toRead: string[] = [], pagesToReadText: string | null = null): Res =>
  ok({ document, pagesToRead: [], pagesToReadText, reading: { source: sentences.length ? 'ia' : 'manuel', sentences, toRead, dropped: 0 } });
const PDF_PV = '/v1/dossiers/f1/copropriete/pdf?kind=pv_assemblee&meetingDay=2027-02-10';
const PDF_FICHE = '/v1/dossiers/f1/copropriete/pdf?kind=fiche_synthetique';
const RESUME = '/v1/dossiers/f1/copropriete/resume';
const BUYER = '/v1/dossiers/f1/copropriete/acquereur';
const SUMMARY = {
  id: 's3', fileId: 'f1', version: 3,
  documents: [{ ref: REF_A, kind: 'pv_assemblee', pages: 2, hash: '0'.repeat(64), meetingDay: '2027-02-10' }],
  topics: [{ topic: 'travaux_votes', found: true, sentences: [{ topic: 'travaux_votes', text: SENTENCE.text, cite: { documentRef: REF_A, kind: 'pv_assemblee', page: 2, quote: SENTENCE.quote, meetingDay: '2027-02-10' } }] }],
  registry: { found: false, text: 'non trouvé', source: 'Registre national des copropriétés (ANAH)', collectedOn: null, reason: 'non_collecte' },
  urbanism: { found: false, text: 'non trouvé', source: 'Géoportail de l’urbanisme (IGN)', collectedOn: null, reason: 'non_collecte' },
  worksToNotify: [], rejected: [], hash: '0'.repeat(64), preparedAt: '2027-03-11T09:00:00.000Z',
};
const pdfFile = (name = 'pv.pdf', type = 'application/pdf') => ({ name, type, size: 10 });

function mount(table: Record<string, () => Promise<Res>> = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let session = 1;
  const el = (tag: string, text?: unknown, cls?: string) => {
    const e = new FakeElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  };
  const clear = (e: FakeElement) => {
    e.textContent = '';
  };
  const answer = (method: string, path: string, body: unknown) => {
    calls.push({ path, method, body });
    const a = table[`${method} ${path}`];
    return a ? a() : Promise.resolve({ offline: true } as Res);
  };
  const context: Record<string, unknown> = { Date, JSON, Object, String, Number, isNaN, Promise, Math, Array, encodeURIComponent, TextEncoder };
  context.globalThis = context;
  runInNewContext(COPROPRIETE_SCRIPT, context);
  const make = context.AIMMO_COPROPRIETE as (t: unknown) => { prepare: (box: FakeElement, id: string) => boolean };
  const screen = make({
    el,
    clear,
    send: (path: string, method: string, body?: unknown) => answer(method, path, body),
    sendPdf: (path: string, file: unknown) => answer('PDF', path, file),
    session: () => session,
  });
  const box = new FakeElement('div');
  const byLabel = (label: string) => {
    const l = box.all().find((e) => e.tagName === 'label' && e.textContent === label);
    if (!l) throw new Error(`champ absent : ${label}`);
    return box.all().find((e) => e.attributes.id === l.attributes.for)! as FakeElement & { files?: unknown[] };
  };
  const click = async (text: string) => {
    const b = box.all().find((e) => e.tagName === 'button' && e.textContent === text);
    if (!b) throw new Error(`bouton absent : ${text}`);
    b.listeners.click!({});
    await settle();
  };
  const states = () => box.all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent);
  const boxes = () => box.all().filter((e) => e.tagName === 'input' && e.attributes.type === 'checkbox');
  const deposit = async (kind: string, file: unknown, day = '') => {
    byLabel('Sorte du document').value = kind;
    byLabel('Jour de l’assemblée, pour un procès-verbal').value = day;
    byLabel('Fichier PDF').files = file ? [file] : [];
    await click('Déposer et prélire');
  };
  const sent = (method: string) => calls.filter((c) => c.method === method);
  return { calls, box, screen, byLabel, click, states, boxes, deposit, sent, leave: () => (session += 1), open: (id = 'f1') => screen.prepare(box, id) };
}

describe('BR90 · le résumé de copropriété préparé à l’écran depuis les PDF déposés', () => {
  it('[R12] chaque PDF part tel quel, sorte et jour d’assemblée dans l’adresse ; ce qui manque se dit avant tout envoi', async () => {
    const t = mount({ [`PDF ${PDF_PV}`]: async () => read(PV) });
    expect(t.open()).toBe(true);
    await t.deposit('', pdfFile());
    expect(t.states()[0]).toBe('Choisissez la sorte du document.');
    await t.deposit('pv_assemblee', pdfFile());
    expect(t.states()[0]).toBe('Donnez le jour de l’assemblée du procès-verbal.');
    await t.deposit('pv_assemblee', null, '2027-02-10');
    expect(t.states()[0]).toBe('Choisissez le fichier PDF.');
    await t.deposit('pv_assemblee', pdfFile('photo.jpg', 'image/jpeg'), '2027-02-10');
    expect(t.states()[0]).toBe('Déposez le document en PDF.');
    expect(t.calls).toEqual([]);
    const file = pdfFile();
    await t.deposit('pv_assemblee', file, '2027-02-10');
    expect(t.calls).toEqual([{ method: 'PDF', path: PDF_PV, body: file }]);
    expect(t.box.textContent).toContain('procès-verbal d’assemblée du 10 février 2027, 2 pages');
  });

  it('[R12] un refus du serveur se dit en mots, jamais un code', async () => {
    const cases: [Res, string][] = [
      [no(422, 'encrypted', 'Ce PDF est protégé par un mot de passe : son texte ne peut pas être lu. Lisez-le vous-même.'), 'Ce PDF est protégé par un mot de passe : son texte ne peut pas être lu. Lisez-le vous-même.'],
      [no(413, 'too_large', 'Ce PDF est trop gros pour être lu ici. Lisez-le vous-même.'), 'Ce PDF est trop gros pour être lu ici. Lisez-le vous-même.'],
      [no(422, 'unreadable'), COPRO_PDF_FAILED],
      [no(500, 'boom'), COPRO_PDF_FAILED],
      [no(403, 'role'), COPRO_PREP_ROLE],
      [no(409, 'file_stopped'), COPRO_PREP_STOPPED],
      [{ offline: true }, COPRO_OFFLINE],
      [read({ ...PV, ref: 'dossiers/f1/x.pdf' }), COPRO_PDF_FAILED],
      [read({ ...PV, kind: 'fiche_synthetique' }), COPRO_PDF_FAILED],
    ];
    for (const [res, said] of cases) {
      const t = mount({ [`PDF ${PDF_PV}`]: async () => res });
      t.open();
      await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
      expect(t.states()[0]).toBe(said);
      expect(t.box.textContent).not.toMatch(/encrypted|too_large|unreadable|boom|file_stopped|\brole\b/);
      expect(t.box.textContent).not.toContain('2 pages');
    }
  });

  it('un même fichier, à la même empreinte, ne compte jamais deux fois', async () => {
    const t = mount({ [`PDF ${PDF_PV}`]: async () => read(PV, [SENTENCE]) });
    t.open();
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    await t.deposit('pv_assemblee', pdfFile('copie.pdf'), '2027-02-10');
    expect(t.states()[0]).toBe(COPRO_PDF_TWICE);
    expect(t.boxes()).toHaveLength(1);
    t.byLabel('Adresse du bien, pour lire la zone au Géoportail (facultatif)').value = '';
    await t.click('Préparer le résumé');
    const body = t.sent('POST')[0]!.body as { documents: unknown[] };
    expect(body.documents).toEqual([PV]);
  });

  it('[R448] aucune phrase proposée n’est cochée d’avance ; seules les cochées partent, recalées sur leur document (Jamais vu)', async () => {
    const t = mount({
      [`PDF ${PDF_FICHE}`]: async () => read(FICHE),
      [`PDF ${PDF_PV}`]: async () => read(PV, [SENTENCE, { ...SENTENCE, page: 9 }, { ...SENTENCE, document: 1 }]),
      [`POST ${RESUME}`]: async () => ok(SUMMARY),
      [`GET ${RESUME}`]: async () => ok(SUMMARY),
      [`GET ${BUYER}`]: async () => ok({ summaryId: 's3', lines: [], works: [] }),
    });
    t.open();
    await t.deposit('fiche_synthetique', pdfFile('fiche.pdf'));
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    // Une phrase qui vise une page absente ou un autre document est jetée, jamais montrée.
    expect(t.boxes()).toHaveLength(1);
    expect(t.boxes()[0]!.checked).toBe(false);
    expect(t.box.textContent).toContain('Travaux votés : Le ravalement de la façade est voté pour 42 000 €.');
    expect(t.box.textContent).toContain('procès-verbal d’assemblée du 10 février 2027, page 2 : « ravalement de la façade voté pour 42 000 € »');
    await t.click('Préparer le résumé');
    expect((t.sent('POST')[0]!.body as { sentences: unknown[] }).sentences).toEqual([]);
    t.boxes()[0]!.checked = true;
    await t.click('Préparer le résumé');
    const body = t.sent('POST')[1]!.body as { documents: unknown[]; sentences: unknown[] };
    expect(body.documents).toEqual([FICHE, PV]);
    expect(body.sentences).toEqual([{ ...SENTENCE, document: 1 }]);
  });

  it('[R450] [R12] les pages et les rubriques à lire se disent en mots ; sans phrase proposée, l’agent est invité à lire', async () => {
    const t = mount({ [`PDF ${PDF_PV}`]: async () => read(PV, [], ['travaux_votes', 'impayes'], 'La page 1 n’a pas pu être lue : lisez-la vous-même.') });
    t.open();
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    expect(t.states()[0]).toBe(`La page 1 n’a pas pu être lue : lisez-la vous-même. À lire vous-même : Travaux votés, Impayés. ${COPRO_MANUAL}`);
  });

  it('[R448] la phrase de l’agent : rubrique, document, page et extrait exigés ; ajoutée cochée, montant et échéance avec elle', async () => {
    const t = mount({ [`PDF ${PDF_PV}`]: async () => read(PV), [`POST ${RESUME}`]: async () => ok(SUMMARY) });
    t.open();
    const add = () => t.click('Ajouter la phrase');
    const said = () => t.states()[1];
    await add();
    expect(said()).toBe('Choisissez la rubrique.');
    t.byLabel('Rubrique').value = 'travaux_votes';
    await add();
    expect(said()).toBe('Déposez puis choisissez le document.');
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    t.byLabel('Document').value = '0';
    t.byLabel('Page').value = '3';
    await add();
    expect(said()).toBe('Ce document a 2 pages.');
    t.byLabel('Page').value = '2';
    await add();
    expect(said()).toBe('Donnez l’extrait et votre phrase.');
    t.byLabel('Extrait, tel qu’il se lit dans la page').value = ' ravalement de la façade voté pour 42 000 €, travaux à finir le 30/09/2027 ';
    t.byLabel('Votre phrase, une seule').value = 'Le ravalement est voté, à finir le 30 septembre 2027.';
    t.byLabel('Montant des travaux en euros, s’il se lit dans l’extrait').value = '42000.5';
    await add();
    expect(said()).toBe('Le montant est un nombre entier d’euros.');
    t.byLabel('Montant des travaux en euros, s’il se lit dans l’extrait').value = '42000';
    t.byLabel('Échéance des travaux, si elle se lit dans l’extrait').value = '2027-09-30';
    await add();
    expect(said()).toBe('Phrase ajoutée, cochée.');
    expect(t.boxes()[0]!.checked).toBe(true);
    await t.click('Préparer le résumé');
    expect((t.sent('POST')[0]!.body as { sentences: unknown[] }).sentences).toEqual([
      { topic: 'travaux_votes', text: 'Le ravalement est voté, à finir le 30 septembre 2027.', document: 0, page: 2, quote: 'ravalement de la façade voté pour 42 000 €, travaux à finir le 30/09/2027', works: { amountEur: 42000, dueOn: '2027-09-30' } },
    ]);
  });

  it('[R449] le corps ne porte que les documents, les phrases et l’adresse : aucun champ de zone ni de registre (Jamais vu)', async () => {
    const t = mount({ [`PDF ${PDF_PV}`]: async () => read(PV), [`POST ${RESUME}`]: async () => ok(SUMMARY) });
    t.open();
    const labels = t.box.all().filter((e) => e.tagName === 'label').map((e) => e.textContent);
    expect(labels.some((l) => /zone|registre|immatricul|servitude|préemption/i.test(l) && !l.includes('Géoportail'))).toBe(false);
    await t.click('Préparer le résumé');
    expect(t.states()[2]).toBe(COPRO_NO_DOC);
    expect(t.sent('POST')).toEqual([]);
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    t.byLabel('Adresse du bien, pour lire la zone au Géoportail (facultatif)').value = '  3 rue Inventée, 21000 Dijon  ';
    await t.click('Préparer le résumé');
    const body = t.sent('POST')[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['address', 'documents', 'sentences']);
    expect(body.address).toBe('3 rue Inventée, 21000 Dijon');
    expect(t.sent('POST')[0]!.path).toBe(RESUME);
  });

  it('[R448] le résumé préparé est relu aussitôt, et chaque phrase écartée revient avec sa raison en mots', async () => {
    const t = mount({
      [`PDF ${PDF_PV}`]: async () => read(PV, [SENTENCE, { ...SENTENCE, text: 'Le toit est refait.', quote: 'Feuille de présence et toit', page: 1 }]),
      [`POST ${RESUME}`]: async () => ok({ ...SUMMARY, rejected: [{ index: 1, reason: 'extrait_absent_de_la_page' }] }),
      [`GET ${RESUME}`]: async () => ok(SUMMARY),
      [`GET ${BUYER}`]: async () => ok({ summaryId: 's3', lines: ['Travaux votés en assemblée du 10/02/2027 : ravalement.'], works: [] }),
    });
    t.open();
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    t.boxes().forEach((b) => (b.checked = true));
    await t.click('Préparer le résumé');
    expect(t.states()).toContain('Résumé préparé, version 3.');
    expect(t.box.textContent).toContain('Le toit est refait. : écartée, l’extrait ne se lit pas dans cette page.');
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PDF ${PDF_PV}`, `POST ${RESUME}`, `GET ${RESUME}`, `GET ${BUYER}`]);
    expect(t.box.textContent).toContain('Résumé, version 3, préparé le 11 mars 2027.');
    expect(t.box.textContent).toContain('Travaux votés en assemblée du 10/02/2027 : ravalement.');
  });

  it('[R16] refus de droits, dossier arrêté, préparation simultanée, réponse perdue : dits en mots, jamais un code', async () => {
    const cases: [Res, string][] = [
      [no(403, 'role'), COPRO_PREP_ROLE],
      [no(409, 'file_stopped'), COPRO_PREP_STOPPED],
      [no(409, 'busy'), COPRO_PREP_BUSY],
      [{ offline: true }, COPRO_OFFLINE],
      [no(400, 'bad_documents'), COPRO_PREP_FAILED],
      [ok({ ...SUMMARY, fileId: 'f2' }), COPRO_PREP_FAILED],
    ];
    for (const [res, said] of cases) {
      const t = mount({ [`PDF ${PDF_PV}`]: async () => read(PV), [`POST ${RESUME}`]: async () => res });
      t.open();
      await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
      await t.click('Préparer le résumé');
      expect(t.states()[2]).toBe(said);
      expect(t.box.textContent).not.toMatch(/bad_documents|file_stopped|busy|\brole\b/);
      expect(t.sent('GET')).toEqual([]);
    }
  });

  it('[R16] une session finie n’envoie rien et sa réponse est jetée ; un identifiant douteux n’ouvre rien', async () => {
    let release: (r: Res) => void = () => undefined;
    const t = mount({ [`PDF ${PDF_PV}`]: () => new Promise<Res>((r) => (release = r)) });
    t.open();
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    t.leave();
    release(read(PV, [SENTENCE]));
    await settle();
    expect(t.boxes()).toEqual([]);
    expect(t.box.textContent).not.toContain('2 pages');
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    await t.click('Préparer le résumé');
    expect(t.calls).toHaveLength(1);

    const u = mount();
    expect(u.screen.prepare(u.box, '../f1')).toBe(false);
    expect(u.box.all().some((e) => e.tagName === 'button')).toBe(false);
  });

  it('un document qui ne tient plus dans le résumé n’est pas gardé ; trop de phrases cochées : dit en mots, rien n’est envoyé', async () => {
    const half = { ...PV, pages: ['x'.repeat((COPRO_PREP_MAX_BYTES - COPRO_SENTENCES_ROOM) / 2)] };
    const t = mount({
      [`PDF ${PDF_PV}`]: async () => read(half),
      [`PDF ${PDF_FICHE}`]: async () => read({ ...FICHE, pages: ['y'.repeat((COPRO_PREP_MAX_BYTES - COPRO_SENTENCES_ROOM) / 2)] }),
      [`POST ${RESUME}`]: async () => ok(SUMMARY),
    });
    t.open();
    await t.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    await t.deposit('fiche_synthetique', pdfFile('fiche.pdf'));
    expect(t.states()[0]).toBe(COPRO_DOC_TOO_BIG);
    expect(t.box.textContent).not.toContain('fiche synthétique, 1 page');
    // La préparation reste possible avec ce qui a été gardé.
    await t.click('Préparer le résumé');
    expect((t.sent('POST')[0]!.body as { documents: { ref: string }[] }).documents.map((d) => d.ref)).toEqual([REF_A]);

    const u = mount({ [`PDF ${PDF_PV}`]: async () => read({ ...PV, pages: ['Résolution : ' + 'z'.repeat(COPRO_PREP_MAX_BYTES - COPRO_SENTENCES_ROOM - 2000)] }) });
    u.open();
    await u.deposit('pv_assemblee', pdfFile(), '2027-02-10');
    u.byLabel('Rubrique').value = 'charges';
    u.byLabel('Document').value = '0';
    u.byLabel('Page').value = '1';
    for (let i = 0; i < 3; i++) {
      u.byLabel('Extrait, tel qu’il se lit dans la page').value = 'z'.repeat(100_000);
      u.byLabel('Votre phrase, une seule').value = 'Les charges sont dites.';
      await u.click('Ajouter la phrase');
    }
    await u.click('Préparer le résumé');
    expect(u.states()[2]).toBe(COPRO_TOO_BIG);
    expect(u.sent('POST')).toEqual([]);
  });

  it('[R201] les plafonds, les sortes et les rubriques sont ceux du serveur ; chaque raison d’écart a ses mots ; budgets tenus', () => {
    expect(COPRO_PREP_MAX_BYTES).toBe(MAX_COPROPRIETE_BODY_BYTES);
    expect(COPRO_KIND_ORDER).toEqual([...DOCUMENT_KINDS]);
    expect(COPRO_TOPIC_ORDER).toEqual([...TOPICS]);
    expect(Object.values(COPRO_REJECTED).every((v) => v.length > 0 && !/_/.test(v))).toBe(true);
    expect(COPROPRIETE_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    expect(budgetProblems({ html: '', js: COPROPRIETE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});

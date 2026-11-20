import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEPOSIT_HOLDERS } from '../../core/src/avant-contrat/avant-contrat.ts';
import { ALL_TERMS } from '../../core/src/avant-contrat/lecture-projet.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CONDITION_KINDS } from '../../core/src/offres/registre-offres.ts';
import { AC_CONDITIONS, AC_HOLDERS, AC_MANUAL, AC_READ_FAILED, AC_REFUSALS, AC_ROLE, AC_STALE, AC_TERMS, AC_WRITER, AVANT_CONTRAT_SCRIPT } from '../app/avant-contrat.ts';
import { DOSSIER_SCRIPT } from '../app/dossier.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement } from './fake-dom.ts';

// BR91. Tout est inventé : dossier, montants, dates, fichiers.
type Res = { ok?: boolean; status?: number; body?: unknown; offline?: boolean; gone?: boolean; refused?: string };
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const INJECTED = '<img src=x onerror="alert(1)">';
const REF = 'preuves/0b0e5c1e-2f4a-4c3b-9d8e-7f6a5b4c3d2e.pdf';
const ATT = 'preuves/1b0e5c1e-2f4a-4c3b-9d8e-7f6a5b4c3d2e.pdf';
const BASE = '/v1/dossiers/f1/avant-contrat';
const PDF_URL = `${BASE}/pdf?documentRef=${encodeURIComponent(REF)}`;
const ok = (data: unknown): Res => ({ ok: true, status: 200, body: { ok: true, mode: 'essai', data } });
const no = (status: number, code: string, rule: string | null = null, message?: string): Res => ({ ok: false, status, body: { ok: false, rule, code, ...(message ? { message } : {}) } });

const BRIEF = { id: 'b1', fileId: 'f1', version: 2, terms: {}, hash: 'h', text: `Prix convenu : 250 000 €.\nDépôt de garantie prévu : 12 500 €, reçu par le notaire.\n${INJECTED}`, preparedAt: '2027-03-01T09:00:00.000Z' };
const DRAFT = { id: 'd1', fileId: 'f1', version: 1, documentRef: REF, briefId: 'b1', terms: {}, recordedAt: '2027-03-05T09:00:00.000Z' };
const EMPTY = { brief: null, draft: null, differences: [], texts: [], comparedToEarlierBrief: false, blocked: false, deposit: { expectedEur: null, receivedEur: null, receivedBy: 'notaire', receivedOn: null, status: 'sans_objet' } };
const FULL = {
  brief: BRIEF,
  draft: DRAFT,
  differences: [
    { field: 'prix', expected: '250 000 €', found: '255 000 €', page: 2, blocking: false },
    { field: 'depot_garantie.detenteur', expected: 'le notaire', found: "l'agence", page: 4, blocking: true },
  ],
  texts: ['Prix : 250 000 € dans l’offre acceptée et le dossier, 255 000 € dans le projet du notaire (page 2).', 'Dépôt de garantie reçu par : le notaire … (page 4). À faire corriger : le dépôt de garantie est reçu par le notaire.'],
  comparedToEarlierBrief: true,
  blocked: true,
  deposit: { expectedEur: 12500, receivedEur: 12000, receivedBy: 'notaire', receivedOn: '2027-03-06', status: 'ecart' },
};
const PROPOSAL = {
  priceEur: { value: 250000, page: 2 },
  conditions: [{ kind: 'pret', page: 3, amountEur: 200000, durationMonths: 240 }],
  loanDeadline: { value: '2027-05-15', page: 3 },
  deedBy: null,
  deposit: { eur: 12500, page: 4, holder: null },
};
const READ = ok({ documentRef: REF, pageCount: 6, pagesToRead: [5], pagesToReadText: 'La page 5 n’a pas pu être lue : lisez-la vous-même.', reading: { source: 'ia', proposal: PROPOSAL, toRead: ['acte_prevu', 'depot_garantie.detenteur'] } });

function mount(table: Record<string, () => Promise<Res>>, proofs: Res[] = [ok({ ref: REF })], withRefresh = false) {
  const refreshed: string[] = [];
  const calls: { path: string; method: string; body: unknown }[] = [];
  const pdfs: { url: string; file: unknown }[] = [];
  const deposited: unknown[] = [];
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
  const send = (path: string, method: string, body?: unknown) => {
    calls.push({ path, method, body });
    const a = table[`${method} ${path}`];
    return a ? a() : Promise.resolve({ offline: true } as Res);
  };
  const context: Record<string, unknown> = { Date, JSON, Object, String, Number, isNaN, Promise, Math, Array, encodeURIComponent };
  context.globalThis = context;
  runInNewContext(AVANT_CONTRAT_SCRIPT, context);
  const make = context.AIMMO_AVANT_CONTRAT as (t: unknown) => { show: (box: FakeElement, id: string) => Promise<boolean> };
  const screen = make({
    el,
    clear,
    send,
    session: () => session,
    ...(withRefresh ? { refresh: (m: string) => { refreshed.push(m); return Promise.resolve(true); } } : {}),
    proof: (file: unknown) => {
      deposited.push(file);
      return Promise.resolve(proofs.shift() ?? { offline: true });
    },
    sendPdf: (url: string, file: unknown) => {
      pdfs.push({ url, file });
      const a = table[`PDF ${url}`];
      return a ? a() : Promise.resolve({ offline: true } as Res);
    },
  });
  const box = new FakeElement('div');
  const label = (text: string) => {
    const l = box.all().find((e) => e.tagName === 'label' && e.textContent === text);
    if (!l) throw new Error(`champ absent : ${text}`);
    return box.all().find((e) => e.attributes.id === l.attributes.for)! as FakeElement & { files?: unknown[] };
  };
  const find = (text: string) => box.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (text: string) => {
    const b = find(text);
    if (!b) throw new Error(`bouton absent : ${text}`);
    b.listeners.click!({});
    await settle();
  };
  const statuses = () => box.all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent);
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { calls, pdfs, deposited, refreshed, box, screen, label, find, click, statuses, posts, leave: () => (session += 1), show: async (id = 'f1') => { const r = screen.show(box, id); await settle(); return r; } };
}
const pdf = () => ({ type: 'application/pdf', size: 1000, name: 'projet.pdf' });

describe('BR91 · l’avant-contrat préparé à l’écran du dossier', () => {
  it('les mots suivent le cœur : termes, conditions, destinataires', () => {
    expect(Object.keys(AC_TERMS)).toEqual([...ALL_TERMS]);
    expect(Object.keys(AC_CONDITIONS)).toEqual([...CONDITION_KINDS]);
    expect(Object.keys(AC_HOLDERS)).toEqual([...DEPOSIT_HOLDERS]);
  });

  it('[R511] [R512] l’état se lit en mots : note du serveur, différences, bloquante, note plus récente, écart du dépôt', async () => {
    const t = mount({ [`GET ${BASE}`]: async () => ok(FULL) });
    expect(await t.show()).toBe(true);
    const text = t.box.textContent;
    expect(text).toContain('Version 2, préparée le 1 mars 2027.');
    expect(text).toContain('Prix convenu : 250 000 €.');
    // Un texte reçu est posé en texte, jamais lu comme du HTML.
    expect(t.box.all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).toContain(INJECTED);
    expect(text).toContain(FULL.texts[0]);
    const blocking = t.box.all().find((e) => e.tagName === 'li' && e.textContent === FULL.texts[1])!;
    expect(blocking.className).toBe('alerte');
    expect(text).toContain(AC_STALE);
    expect(text).toContain('Les dates de ce projet ne passent pas à l’échéancier tant qu’il n’est pas corrigé.');
    expect(text).toContain('Écart : 12 000 € reçus par le notaire le 6 mars 2027, 12 500 € attendus.');
    const e = mount({ [`GET ${BASE}`]: async () => ok(EMPTY) });
    await e.show();
    expect(e.box.textContent).toContain('Aucune note au notaire n’est encore rangée.');
    expect(e.box.textContent).toContain('Aucun projet du notaire n’est encore rangé.');
    expect(e.box.textContent).toContain('Aucun dépôt de garantie prévu.');
    const w = mount({ [`GET ${BASE}`]: async () => ok({ ...EMPTY, deposit: { expectedEur: 12500, receivedEur: null, receivedBy: 'notaire', receivedOn: null, status: 'attendu' } }) });
    await w.show();
    expect(w.box.textContent).toContain('Attendu : 12 500 €, reçu par le notaire seul.');
  });

  it('[R510] la note ne porte que le dépôt et les dates ; sans prêt, la date limite part vide ; les refus se disent en mots', async () => {
    let state = EMPTY as unknown;
    const t = mount({ [`GET ${BASE}`]: async () => ok(state), [`POST ${BASE}/note`]: async () => { state = { ...EMPTY, brief: BRIEF }; return ok(BRIEF); } });
    await t.show();
    await t.click('Ranger la note');
    expect(t.statuses()).toContain('Donnez le dépôt de garantie prévu, 0 s’il n’y en a pas.');
    t.label('Dépôt de garantie prévu, en euros (0 si aucun)').value = '12500';
    await t.click('Ranger la note');
    expect(t.statuses()).toContain(AC_REFUSALS.bad_deed_day);
    expect(t.posts()).toEqual([]);
    t.label('Signature de l’acte au plus tard le').value = '2027-07-01';
    await t.click('Ranger la note');
    expect(t.posts()).toEqual([{ path: `${BASE}/note`, method: 'POST', body: { depositEur: 12500, loanDeadline: null, deedBy: '2027-07-01' } }]);
    expect(t.statuses()[0]).toBe('Note rangée, version 2.');
    expect(t.box.textContent).toContain('Prix convenu : 250 000 €.');

    const cases: [Res, string][] = [
      [no(409, 'compromis_not_started', 'R58'), AC_REFUSALS.compromis_not_started!],
      [no(400, 'bad_order'), AC_REFUSALS.bad_order!],
      [no(409, 'closed'), AC_REFUSALS.closed!],
      [no(403, 'role', 'R16'), AC_WRITER],
      [no(404, 'unknown_file'), AC_ROLE],
      [{ offline: true }, 'Pas de réseau : rien n’est rangé.'],
      [no(500, 'boom'), 'Rien n’est rangé : réessayez dans un moment.'],
    ];
    for (const [res, said] of cases) {
      const u = mount({ [`GET ${BASE}`]: async () => ok(EMPTY), [`POST ${BASE}/note`]: async () => res });
      await u.show();
      u.label('Dépôt de garantie prévu, en euros (0 si aucun)').value = '0';
      u.label('Date limite d’obtention du prêt (vide s’il n’y a pas de prêt)').value = '2027-05-01';
      u.label('Signature de l’acte au plus tard le').value = '2027-07-01';
      await u.click('Ranger la note');
      expect(u.posts()[0]!.body).toEqual({ depositEur: 0, loanDeadline: '2027-05-01', deedBy: '2027-07-01' });
      expect(u.statuses()).toContain(said);
      expect(u.box.textContent).not.toMatch(/compromis_not_started|bad_order|unknown_file|boom|R16|R58/);
    }
  });

  it('[R511] [R12] [R512] le projet est déposé tel quel, prélu sous la référence rendue ; proposé : avec sa page ; non retrouvé : vide, à lire ; destinataire jamais pré-rempli', async () => {
    const t = mount({ [`GET ${BASE}`]: async () => ok({ ...EMPTY, brief: BRIEF }), [`PDF ${PDF_URL}`]: async () => READ });
    await t.show();
    const file = pdf();
    t.label('Le projet reçu du notaire, en PDF').files = [file];
    await t.click('Déposer et prélire');
    expect(t.deposited).toEqual([file]);
    expect(t.pdfs).toEqual([{ url: PDF_URL, file }]);
    expect(t.statuses()).toContain('La page 5 n’a pas pu être lue : lisez-la vous-même.');
    expect(t.label('Prix, en euros').value).toBe('250000');
    expect(t.label('Page du prix').value).toBe('2');
    expect(t.box.textContent).toContain('Proposé, retrouvé page 2 : vérifiez.');
    expect(t.label('Montant du prêt, en euros').value).toBe('200000');
    expect(t.label('Durée du prêt, en mois').value).toBe('240');
    expect(t.label('Date limite d’obtention du prêt (vide si le projet n’en dit pas)').value).toBe('2027-05-15');
    expect(t.label('Date de l’acte (vide si le projet n’en dit pas)').value).toBe('');
    expect(t.label('Dépôt de garantie du projet, en euros (vide s’il n’en dit pas)').value).toBe('12500');
    expect(t.label('Selon le projet, le dépôt est reçu par').value).toBe('');
    expect(t.box.textContent).toContain('À lire vous-même : la date de l’acte, qui reçoit le dépôt de garantie.');
    // Rien n'est rangé par la prélecture.
    expect(t.posts()).toEqual([]);
  });

  it('[R12] sans IA, ou une prélecture refusée : le fichier reste déposé, tout est vide et à lire', async () => {
    const manual = ok({ documentRef: REF, pageCount: 3, pagesToRead: [], pagesToReadText: null, reading: { source: 'manuel', proposal: { priceEur: null, conditions: [], loanDeadline: null, deedBy: null, deposit: null }, toRead: [...ALL_TERMS] } });
    const t = mount({ [`GET ${BASE}`]: async () => ok(EMPTY), [`PDF ${PDF_URL}`]: async () => manual });
    await t.show();
    t.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    await t.click('Déposer et prélire');
    expect(t.statuses()).toContain(AC_MANUAL);
    expect(t.label('Prix, en euros').value).toBe('');
    expect(t.box.textContent).toContain('À lire vous-même : le prix, les conditions suspensives, la date limite du prêt, la date de l’acte, le montant du dépôt de garantie, qui reçoit le dépôt de garantie.');

    const refused = mount({ [`GET ${BASE}`]: async () => ok(EMPTY), [`PDF ${PDF_URL}`]: async () => no(422, 'unreadable', null, 'Ce PDF ne se lit pas.') });
    await refused.show();
    refused.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    await refused.click('Déposer et prélire');
    expect(refused.statuses().join(' ')).toContain('Ce PDF ne se lit pas.');
    expect(refused.label('Prix, en euros').value).toBe('');

    const notPdf = mount({ [`GET ${BASE}`]: async () => ok(EMPTY) });
    await notPdf.show();
    notPdf.label('Le projet reçu du notaire, en PDF').files = [{ type: 'image/png', size: 10 }];
    await notPdf.click('Déposer et prélire');
    expect(notPdf.statuses()).toContain('Déposez le projet en PDF.');
    expect(notPdf.deposited).toEqual([]);

    const big = mount({ [`GET ${BASE}`]: async () => ok(EMPTY) }, [{ refused: 'Ce fichier dépasse 20 Mo.' }]);
    await big.show();
    big.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    await big.click('Déposer et prélire');
    expect(big.statuses()).toContain('Ce fichier dépasse 20 Mo.');
    expect(big.pdfs).toEqual([]);
  });

  it('[R511] [R512] le projet ne se range qu’après relecture et confirmation, chaque terme avec sa page, le destinataire lu par l’agent', async () => {
    let state = { ...EMPTY, brief: BRIEF } as unknown;
    const t = mount({
      [`GET ${BASE}`]: async () => ok(state),
      [`PDF ${PDF_URL}`]: async () => READ,
      [`POST ${BASE}/projet`]: async () => {
        state = FULL;
        return ok({ draft: DRAFT, differences: FULL.differences, dates: null });
      },
    });
    await t.show();
    t.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    await t.click('Déposer et prélire');
    await t.click('Relire avant de ranger');
    expect(t.statuses()).toContain('Lisez dans le projet qui reçoit le dépôt de garantie.');
    expect(t.find('Confirmer : c’est ce que dit le projet')).toBeUndefined();
    t.label('Selon le projet, le dépôt est reçu par').value = 'agence';
    t.label('Date de l’acte (vide si le projet n’en dit pas)').value = '2027-07-01';
    await t.click('Relire avant de ranger');
    expect(t.statuses()).toContain('Donnez la date de l’acte et sa page, ou laissez les deux vides.');
    t.label('Page de la date de l’acte').value = '5';
    await t.click('Relire avant de ranger');
    expect(t.posts()).toEqual([]);
    const text = t.box.textContent;
    expect(text).toContain('Prix : 250 000 €, page 2.');
    expect(text).toContain('Obtention du prêt de 200 000 € sur 240 mois, page 3.');
    expect(text).toContain('Dépôt de garantie : 12 500 €, reçu par l’agence, page 4.');
    // Une saisie changée après la relecture ne part pas : c'est ce qui a été relu qui part.
    t.label('Prix, en euros').value = '999999';
    await t.click('Confirmer : c’est ce que dit le projet');
    expect(t.posts()).toEqual([
      {
        path: `${BASE}/projet`,
        method: 'POST',
        body: {
          documentRef: REF,
          priceEur: { value: 250000, page: 2 },
          conditions: [{ kind: 'pret', page: 3, amountEur: 200000, durationMonths: 240 }],
          loanDeadline: { value: '2027-05-15', page: 3 },
          deedBy: { value: '2027-07-01', page: 5 },
          deposit: { eur: 12500, holder: 'agence', page: 4 },
        },
      },
    ]);
    expect(t.statuses()[0]).toBe('Projet rangé, version 1.');
    expect(t.box.textContent).toContain(FULL.texts[1]);
  });

  it('[R511] AU079 · le taux maximal et le type du prêt sont prélus, se corrigent et partent avec la condition', async () => {
    const loan = { kind: 'pret', page: 3, amountEur: 200000, durationMonths: 240, maxRateBp: 385, loanType: 'amortissable' };
    const read = ok({ documentRef: REF, pageCount: 6, pagesToRead: [], pagesToReadText: '', reading: { source: 'ia', proposal: { ...PROPOSAL, conditions: [loan] }, toRead: ['acte_prevu', 'depot_garantie.detenteur'] } });
    const t = mount({ [`GET ${BASE}`]: async () => ok({ ...EMPTY, brief: BRIEF }), [`PDF ${PDF_URL}`]: async () => read, [`POST ${BASE}/projet`]: async () => ok({ draft: DRAFT, differences: [], dates: null }) });
    await t.show();
    t.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    await t.click('Déposer et prélire');
    const rate = t.label('Taux nominal maximal hors assurance, en % (vide si le projet n’en dit pas)');
    const type = t.label('Type de prêt selon le projet');
    expect(rate.value).toBe('3,85');
    expect(type.value).toBe('amortissable');
    expect(type.children.map((o) => o.attributes.value)).toEqual(['', 'amortissable', 'in_fine', 'relais', 'ptz']);
    t.label('Selon le projet, le dépôt est reçu par').value = 'notaire';
    rate.value = '3,855';
    await t.click('Relire avant de ranger');
    expect(t.statuses()).toContain('Le taux maximal du prêt s’écrit en %, de 0,01 à 20, deux décimales au plus, ou se laisse vide.');
    rate.value = '4,2 %';
    await t.click('Relire avant de ranger');
    expect(t.box.textContent).toContain('Obtention du prêt amortissable de 200 000 € sur 240 mois, taux hors assurance 4,20 % au plus, page 3.');
    await t.click('Confirmer : c’est ce que dit le projet');
    expect((t.posts()[0]!.body as { conditions: unknown[] }).conditions).toEqual([{ kind: 'pret', page: 3, amountEur: 200000, durationMonths: 240, maxRateBp: 420, loanType: 'amortissable' }]);
  });

  it('[R513] [R512] les dates se reportent d’un geste ; compromis pas signé ou différence bloquante : dits en mots', async () => {
    const t = mount({ [`GET ${BASE}`]: async () => ok(FULL), [`POST ${BASE}/dates`]: async () => ok({ date_limite_pret: 'ecrite', acte_prevu: 'deja_la' }) });
    await t.show();
    await t.click('Reporter les dates du projet à l’échéancier');
    expect(t.posts()).toEqual([{ path: `${BASE}/dates`, method: 'POST', body: {} }]);
    expect(t.statuses()[0]).toBe('Date limite du prêt : écrite à l’échéancier. Date de l’acte : déjà à l’échéancier.');
    for (const [res, said] of [
      [no(409, 'compromis_not_signed', 'R513'), AC_REFUSALS.compromis_not_signed!],
      [no(409, 'blocking_difference', 'R512'), AC_REFUSALS.blocking_difference!],
      [no(409, 'no_draft'), AC_REFUSALS.no_draft!],
    ] as [Res, string][]) {
      const u = mount({ [`GET ${BASE}`]: async () => ok(FULL), [`POST ${BASE}/dates`]: async () => res });
      await u.show();
      await u.click('Reporter les dates du projet à l’échéancier');
      expect(u.statuses()).toContain(said);
    }
  });

  it('[R513] une date écrite à l’échéancier fait relire tout le dossier ; sinon seul le bloc se relit (remarque de Codex)', async () => {
    const t = mount({ [`GET ${BASE}`]: async () => ok(FULL), [`POST ${BASE}/dates`]: async () => ok({ date_limite_pret: 'ecrite' }) }, [], true);
    await t.show();
    await t.click('Reporter les dates du projet à l’échéancier');
    expect(t.refreshed).toEqual(['Date limite du prêt : écrite à l’échéancier.']);
    expect(t.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    const u = mount({ [`GET ${BASE}`]: async () => ok(FULL), [`POST ${BASE}/dates`]: async () => ok({ acte_prevu: 'deja_la' }) }, [], true);
    await u.show();
    await u.click('Reporter les dates du projet à l’échéancier');
    expect(u.refreshed).toEqual([]);
    expect(u.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    const v = mount({ [`GET ${BASE}`]: async () => ok({ ...EMPTY, brief: BRIEF }), [`PDF ${PDF_URL}`]: async () => READ, [`POST ${BASE}/projet`]: async () => ok({ draft: DRAFT, differences: [], dates: { date_limite_pret: 'ecrite' } }) }, [ok({ ref: REF })], true);
    await v.show();
    v.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    await v.click('Déposer et prélire');
    v.label('Selon le projet, le dépôt est reçu par').value = 'notaire';
    await v.click('Relire avant de ranger');
    await v.click('Confirmer : c’est ce que dit le projet');
    expect(v.refreshed).toEqual(['Projet rangé, version 1.']);
  });

  it('[R512] le dépôt reçu part avec son attestation déposée, reçu par le notaire seul, sans aucun autre choix', async () => {
    const t = mount({ [`GET ${BASE}`]: async () => ok(FULL), [`POST ${BASE}/depot`]: async () => ok(FULL.deposit) }, [ok({ ref: ATT })]);
    await t.show();
    const depo = t.box.all().find((e) => e.tagName === 'div' && e.textContent.startsWith('Dépôt de garantie reçu par le notaire'))!;
    expect(depo.all().some((e) => e.tagName === 'select')).toBe(false);
    await t.click('Ranger le dépôt reçu');
    expect(t.statuses()).toContain(AC_REFUSALS.bad_amount);
    t.label('Montant reçu par le notaire, en euros').value = '12500';
    t.label('Reçu le').value = '2027-03-06';
    await t.click('Ranger le dépôt reçu');
    expect(t.statuses()).toContain('Joignez l’attestation du notaire.');
    expect(t.posts()).toEqual([]);
    t.label('L’attestation du notaire').files = [pdf()];
    await t.click('Ranger le dépôt reçu');
    expect(t.posts()).toEqual([{ path: `${BASE}/depot`, method: 'POST', body: { amountEur: 12500, receivedBy: 'notaire', receivedOn: '2027-03-06', proofRef: ATT } }]);
    expect(t.statuses()[0]).toBe('Dépôt reçu par le notaire, rangé.');
    const u = mount({ [`GET ${BASE}`]: async () => ok(FULL), [`POST ${BASE}/depot`]: async () => no(403, 'notary_only', 'R512') }, [ok({ ref: ATT })]);
    await u.show();
    u.label('Montant reçu par le notaire, en euros').value = '12500';
    u.label('Reçu le').value = '2027-03-06';
    u.label('L’attestation du notaire').files = [pdf()];
    await u.click('Ranger le dépôt reçu');
    expect(u.statuses()).toContain(AC_REFUSALS.notary_only);
  });

  it('[R16] refus de droits et réponse perdue dits en mots ; une réponse d’un autre dossier ou d’une session finie est jetée', async () => {
    for (const [res, said] of [
      [no(403, 'not_own_file', 'R16'), AC_ROLE],
      [no(404, 'unknown_file'), AC_ROLE],
      [{ offline: true }, 'Pas de réseau. Réessayez dans un moment.'],
      [no(500, 'boom'), AC_READ_FAILED],
    ] as [Res, string][]) {
      const t = mount({ [`GET ${BASE}`]: async () => res });
      expect(await t.show()).toBe(false);
      expect(t.statuses()).toEqual([said]);
      expect(t.box.textContent).not.toMatch(/not_own_file|unknown_file|boom|R16/);
      expect(t.find('Ranger la note')).toBeUndefined();
    }
    const other = mount({ [`GET ${BASE}`]: async () => ok({ ...FULL, brief: { ...BRIEF, fileId: 'f2' } }) });
    expect(await other.show()).toBe(false);
    expect(other.box.textContent).not.toContain('Prix convenu');

    let release: (r: Res) => void = () => undefined;
    const slow = mount({ [`GET ${BASE}`]: () => new Promise<Res>((r) => (release = r)) });
    const first = slow.screen.show(slow.box, 'f1');
    slow.leave();
    release(ok(FULL));
    expect(await first).toBe(false);
    expect(slow.box.textContent).not.toContain('Prix convenu');

    // Une session finie : rien n'est déposé ni prélu.
    const gone = mount({ [`GET ${BASE}`]: async () => ok(EMPTY), [`PDF ${PDF_URL}`]: async () => READ });
    await gone.show();
    gone.label('Le projet reçu du notaire, en PDF').files = [pdf()];
    gone.leave();
    await gone.click('Déposer et prélire');
    expect(gone.pdfs).toEqual([]);
    expect(gone.deposited).toEqual([]);

    const unsafe = mount({});
    expect(await unsafe.show('../f1')).toBe(false);
    expect(unsafe.calls).toEqual([]);
  });

  it('[R201] servi à part, chargé depuis le dossier, sans innerHTML ni fetch, budgets tenus', () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/avant-contrat.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(AGENT_APP_FILES['/app/avant-contrat.js']).toBe(AVANT_CONTRAT_SCRIPT);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('AIMMO_AVANT_CONTRAT');
    expect(DOSSIER_SCRIPT).toContain("'/app/avant-contrat.js'");
    expect(AVANT_CONTRAT_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    expect(budgetProblems({ html: '', js: AVANT_CONTRAT_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: DOSSIER_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});

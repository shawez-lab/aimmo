import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { COPRO_CHANGED, COPRO_FAILED, COPRO_NO_WORKS, COPRO_NONE, COPRO_OFFLINE, COPRO_ROLE, COPROPRIETE_SCRIPT } from '../app/copropriete.ts';
import { DOSSIER_SCRIPT } from '../app/dossier.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement } from './fake-dom.ts';

// BR88. Tout est inventé : dossier, documents, phrases, zone, montants.
type Res = { ok?: boolean; status?: number; body?: unknown; offline?: boolean; gone?: boolean };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const INJECTED = '<img src=x onerror="alert(1)">';
const SHA = '0123456789abcdef'.repeat(4);
const SUMMARY = {
  id: 's1',
  fileId: 'f1',
  version: 2,
  documents: [{ ref: 'sha256:x', kind: 'pv_assemblee', pages: 12, hash: SHA, meetingDay: '2027-02-10' }],
  topics: [
    {
      topic: 'travaux_votes',
      found: true,
      sentences: [
        {
          topic: 'travaux_votes',
          text: 'Le ravalement de la façade est voté pour 42 000 €.',
          cite: { documentRef: 'sha256:x', kind: 'pv_assemblee', page: 7, quote: 'ravalement de la façade voté pour 42 000 €', meetingDay: '2027-02-10' },
          works: { amountEur: 42000, dueOn: '2027-09-30' },
        },
      ],
    },
    { topic: 'procedures', found: false, text: 'non trouvé', reason: 'absent_des_documents' },
    { topic: 'servitudes', found: false, text: 'non trouvé', reason: 'aucun_document' },
  ],
  registry: { found: false, text: 'non trouvé', source: 'Registre national des copropriétés (ANAH)', collectedOn: null, reason: 'non_collecte' },
  urbanism: { found: true, value: { documentType: 'PLU', zone: 'UA', label: 'Zone urbaine centrale' }, source: 'Géoportail de l’urbanisme (IGN)', collectedOn: '2027-03-11', dataDate: '2026-12-01' },
  worksToNotify: [],
  rejected: [{ index: 3, reason: 'extrait_absent_de_la_page' }],
  hash: SHA,
  preparedAt: '2027-03-11T09:00:00.000Z',
};
const WORKS_LINE = 'Travaux votés en assemblée du 10/02/2027 : « ravalement de la façade voté pour 42 000 € », 42 000 €, échéance le 30/09/2027 (procès-verbal, p. 7).';
const ok = (data: unknown): Res => ({ ok: true, status: 200, body: { ok: true, mode: 'essai', data } });
const no = (status: number, code: string, rule: string | null = null): Res => ({ ok: false, status, body: { ok: false, rule, code } });
const RESUME = '/v1/dossiers/f1/copropriete/resume';
const BUYER = '/v1/dossiers/f1/copropriete/acquereur';

function mount(table: Record<string, () => Promise<Res>>) {
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
  const send = (path: string, method: string, body?: unknown) => {
    calls.push({ path, method, body });
    const a = table[`${method} ${path}`];
    return a ? a() : Promise.resolve({ offline: true } as Res);
  };
  const context: Record<string, unknown> = { Date, JSON, Object, String, isNaN, Promise, Math, Array, encodeURIComponent };
  context.globalThis = context;
  runInNewContext(COPROPRIETE_SCRIPT, context);
  const make = context.AIMMO_COPROPRIETE as (t: unknown) => { show: (box: FakeElement, id: string) => Promise<boolean> };
  const screen = make({ el, clear, send, session: () => session });
  const box = new FakeElement('div');
  const status = () => box.all().find((e) => e.attributes.role === 'status')!.textContent;
  return { calls, box, screen, status, leave: () => (session += 1), show: async (id = 'f1') => { const r = screen.show(box, id); await settle(); return r; } };
}

describe('BR88 · la copropriété et l’urbanisme relus à l’écran du dossier', () => {
  it('[R448] [R450] chaque phrase avec son document, sa page et son extrait ; une rubrique vide dit « non trouvé » et pourquoi', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [WORKS_LINE], works: [] }) });
    await t.show();
    const text = t.box.textContent;
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${RESUME}`, `GET ${BUYER}`]);
    expect(text).toContain('Résumé, version 2, préparé le 11 mars 2027.');
    expect(text).toContain('Empreinte : 01234567 89abcdef');
    expect(text).toContain('Documents lus : procès-verbal d’assemblée du 10 février 2027, 12 pages.');
    expect(text).toContain('Le ravalement de la façade est voté pour 42 000 €.');
    expect(text).toContain('procès-verbal d’assemblée du 10 février 2027, page 7 : « ravalement de la façade voté pour 42 000 € »');
    expect(text).toContain('Procédures : non trouvé, rien ne le dit dans les documents déposés.');
    expect(text).toContain('Servitudes : non trouvé, aucun document déposé pour cette rubrique.');
    expect(text).toContain('1 phrase proposée écartée');
    expect(t.status()).toBe('');
  });

  it('[R449] [R450] la zone avec sa source, la date de la donnée et le jour de sa lecture ; le registre absent dit pourquoi (Jamais vu)', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    await t.show();
    const text = t.box.textContent;
    expect(text).toContain('Plan d’urbanisme, lu au point du bien : PLU, zone UA (Zone urbaine centrale). Source : Géoportail de l’urbanisme (IGN), donnée du 1 décembre 2026, lue par le serveur le 11 mars 2027.');
    expect(text).toContain('Registre des copropriétés : non trouvé, non collecté : aucune adresse donnée ou service non branché (Registre national des copropriétés (ANAH)).');
    for (const reason of ['introuvable', 'panne'] as const) {
      const u = mount({
        [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, urbanism: { found: false, text: 'non trouvé', source: 'Géoportail de l’urbanisme (IGN)', collectedOn: '2027-03-11', reason } }),
        [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }),
      });
      await u.show();
      expect(u.box.textContent).toContain(reason === 'introuvable' ? 'non trouvé, introuvable au point du bien' : 'non trouvé, le service ne répondait pas au moment du résumé');
    }
  });

  it('[R449] le registre trouvé dit sa fiche, sa source, la date de la donnée et le jour de sa lecture ; le nom d’un syndic bénévole jamais repris', async () => {
    const source = 'Registre national des copropriétés (ANAH)';
    const found = (syndicType: string, syndicName: string | null) => ({ found: true, value: { immatriculation: 'AA1234567', lots: 24, syndicType, syndicName, constructionPeriod: null }, source, collectedOn: '2027-03-11', dataDate: '2027-01-15' });
    const pro = mount({ [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, registry: found('professionnel', 'Syndic Exemple SAS') }), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    await pro.show();
    expect(pro.box.textContent).toContain('Registre des copropriétés : AA1234567, 24 lots, syndic Syndic Exemple SAS. Source : Registre national des copropriétés (ANAH), donnée du 15 janvier 2027, lue par le serveur le 11 mars 2027.');
    const volunteer = mount({ [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, registry: found('benevole', 'Camille Inventé') }), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    await volunteer.show();
    expect(volunteer.box.textContent).toContain('Registre des copropriétés : AA1234567, 24 lots, syndic bénévole. Source : Registre national des copropriétés (ANAH), donnée du 15 janvier 2027');
    expect(volunteer.box.textContent).not.toContain('Camille');
    const broken = mount({ [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, registry: { ...found('professionnel', 'X'), dataDate: 'hier' } }), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    await broken.show();
    expect(broken.box.textContent).toContain('Registre des copropriétés : illisible.');
  });

  it('[R449] aucun champ, aucun envoi : la zone ne se tape jamais à l’écran', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [WORKS_LINE], works: [] }) });
    await t.show();
    expect(t.box.all().filter((e) => ['input', 'select', 'textarea', 'button'].includes(e.tagName))).toEqual([]);
    expect(t.calls.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true);
    const routes = [...COPROPRIETE_SCRIPT.matchAll(/'(\/v1\/[^']*|\/resume|\/acquereur|\/copropriete)'/g)].map((m) => m[1]!);
    expect(new Set(routes)).toEqual(new Set(['/v1/dossiers/', '/copropriete', '/resume', '/acquereur']));
    expect(COPROPRIETE_SCRIPT).not.toMatch(/'POST'|"POST"/);
  });

  it('[R451] les travaux votés à dire à l’acquéreur sont les lignes du serveur, posées en texte ; aucun : dit en mots', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [WORKS_LINE, INJECTED], works: [] }) });
    await t.show();
    const items = t.box.all().filter((e) => e.tagName === 'li').map((e) => e.textContent);
    expect(items).toContain(WORKS_LINE);
    expect(items).toContain(INJECTED);
    expect(t.box.all().some((e) => e.tagName === 'img')).toBe(false);
    const n = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    await n.show();
    expect(n.box.textContent).toContain(COPRO_NO_WORKS);
    const lost = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY) });
    await lost.show();
    expect(lost.box.textContent).toContain('À dire à l’acquéreur' + COPRO_OFFLINE);
  });

  it('[R451] les travaux d’un autre résumé, préparé pendant la lecture, ne se mélangent jamais au résumé montré', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => ok(SUMMARY), [`GET ${BUYER}`]: async () => ok({ summaryId: 's2', lines: [WORKS_LINE], works: [] }) });
    await t.show();
    expect(t.box.textContent).toContain(COPRO_CHANGED);
    expect(t.box.all().filter((e) => e.tagName === 'li').map((e) => e.textContent)).not.toContain(WORKS_LINE);
    expect(t.box.textContent).not.toContain(COPRO_NO_WORKS);
  });

  it('le jour de préparation est celui de Paris, même passé minuit à Paris et pas encore en temps universel', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, preparedAt: '2027-03-11T23:30:00.000Z' }), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    await t.show();
    expect(t.box.textContent).toContain('préparé le 12 mars 2027.');
    expect(t.box.textContent).toContain('donnée du 1 décembre 2026, lue par le serveur le 11 mars 2027.');
  });

  it('aucun résumé : dit en mots, jamais un résumé vide inventé', async () => {
    const t = mount({ [`GET ${RESUME}`]: async () => no(404, 'no_summary'), [`GET ${BUYER}`]: async () => no(404, 'no_summary') });
    expect(await t.show()).toBe(true);
    expect(t.status()).toBe(COPRO_NONE);
    expect(t.box.textContent).not.toContain('non trouvé');
    expect(t.box.textContent).not.toContain('À dire à l’acquéreur');
  });

  it('[R16] refus de droits, dossier inconnu, réponse perdue ou illisible : dits en mots, jamais un code', async () => {
    const cases: [Res, string][] = [
      [no(403, 'not_own_file', 'R16'), COPRO_ROLE],
      [no(404, 'unknown_file'), COPRO_ROLE],
      [{ offline: true }, COPRO_OFFLINE],
      [no(500, 'boom'), COPRO_FAILED],
    ];
    for (const [res, said] of cases) {
      const t = mount({ [`GET ${RESUME}`]: async () => res, [`GET ${BUYER}`]: async () => res });
      expect(await t.show()).toBe(false);
      expect(t.status()).toBe(said);
      expect(t.box.textContent).not.toMatch(/not_own_file|unknown_file|boom|R16/);
    }
    const bad = mount({ [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, version: 'deux' }), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    expect(await bad.show()).toBe(false);
    expect(bad.box.textContent).toContain(COPRO_FAILED);
  });

  it('[R16] une réponse d’un autre dossier, d’une lecture dépassée ou d’une session finie est jetée', async () => {
    const other = mount({ [`GET ${RESUME}`]: async () => ok({ ...SUMMARY, fileId: 'f2' }), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [WORKS_LINE], works: [] }) });
    expect(await other.show()).toBe(false);
    expect(other.box.textContent).not.toContain('ravalement');

    let release: (r: Res) => void = () => undefined;
    const slow = mount({ [`GET ${RESUME}`]: () => new Promise<Res>((r) => (release = r)), [`GET ${BUYER}`]: async () => ok({ summaryId: 's1', lines: [], works: [] }) });
    const first = slow.screen.show(slow.box, 'f1');
    slow.leave();
    release(ok(SUMMARY));
    expect(await first).toBe(false);
    expect(slow.box.textContent).not.toContain('ravalement');

    const unsafe = mount({});
    expect(await unsafe.show('../f1')).toBe(false);
    expect(unsafe.calls).toEqual([]);
  });

  it('[R201] servi à part, chargé depuis le dossier, deux lectures seules, sans innerHTML, budgets tenus', () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/copropriete.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(AGENT_APP_FILES['/app/copropriete.js']).toBe(COPROPRIETE_SCRIPT);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('AIMMO_COPROPRIETE');
    expect(DOSSIER_SCRIPT).toContain("'/app/copropriete.js'");
    expect(COPROPRIETE_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    expect(budgetProblems({ html: '', js: COPROPRIETE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: DOSSIER_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : chiffres, lignes, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const FILES = [
  {
    fileId: 'f1',
    reference: 'REF-T-1',
    city: 'Dijon',
    closedOn: '2027-06-10',
    clients: [
      {
        personId: 'p1',
        side: 'vendeur',
        firstName: 'Léa',
        thankYou: { draft: `Bonjour Léa, merci ${INJECTED}`, calledAt: null, decision: null, sendStatus: null },
        review: { status: 'sent', dueDay: '2027-06-11' },
        reminders: [],
        satisfaction: { score: 5, comment: `Parfait ${INJECTED}`, answeredAt: '2027-06-12T09:00:00.000Z' },
      },
      {
        personId: 'p2',
        side: 'acquereur',
        firstName: null,
        thankYou: { draft: 'Bonjour, merci.', calledAt: '2027-06-11T10:00:00.000Z', decision: 'send', sendStatus: 'waiting' },
        review: { status: 'refused', dueDay: '2027-06-11' },
        reminders: [{ year: 1, dueDay: '2028-06-10', status: 'sent' }],
        satisfaction: null,
      },
    ],
  },
];
const DAY = {
  remercier: [{ fileId: 'f1', personId: 'p1', firstName: 'Léa', side: 'vendeur', reference: 'REF-T-1' }],
  recommandations: [{ referralId: 'r1', personId: 'p9', firstName: INJECTED, dueAt: '2027-06-12T09:00:00.000Z' }],
  taches: [{ fileId: 'f1', kind: 'lien_avis', reference: 'REF-T-1' }],
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok(DAY),
  'GET /v1/apres-vente/dossiers': ok(FILES),
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(init.body === undefined ? { method, url } : { method, url, body: init.body });
      const a = table[`${method} ${url}`] ?? table[`${method} ${url.split('?')[0]}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const byText = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  return { els, calls, table, byText, click, storage };
}

const FIGURES = {
  agentId: 'a1',
  from: '2027-06-01',
  to: '2027-06-30',
  contacts: { value: 2, lines: [{ attributionId: 'at1', personId: 'p1', at: '2027-06-02T08:00:00.000Z' }, { attributionId: 'at2', personId: 'p2', at: '2027-06-03T08:00:00.000Z' }] },
  appointments: { value: 1, lines: [{ appointmentId: 'r1', kind: 'estimation', at: '2027-06-04T08:00:00.000Z' }] },
  mandates: { value: 0, lines: [] },
  sales: { value: 1, lines: [{ fileId: 'f1', signedOn: '2027-06-10' }] },
  upcomingFees: { value: 1234567, lines: [{ fileId: 'f1', status: 'due', amountCents: 1234567 }] },
};

describe('K08 · « Mes chiffres » dans l’application', () => {
  it('chaque chiffre s’ouvre sur ses lignes, et leur nombre est le chiffre affiché ; aucun code interne à l’écran', async () => {
    const t = await run({ 'GET /v1/pilotage/mes-chiffres': ok(FIGURES) });
    await t.click(t.els['chiffres-ouvrir']);
    expect(t.els.chiffres!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    const call = t.calls.find((c) => c.url.startsWith('/v1/pilotage/mes-chiffres'))!;
    expect(call.url).toMatch(/^\/v1\/pilotage\/mes-chiffres\?du=\d{4}-\d{2}-01&au=\d{4}-\d{2}-\d{2}$/);
    const figures = t.els['chiffres-corps']!.all().filter((e) => e.tagName === 'details');
    expect(figures).toHaveLength(5);
    for (const f of figures.slice(0, 4)) {
      const value = Number(f.all().find((e) => e.className === 'valeur')!.textContent);
      expect(f.all().filter((e) => e.tagName === 'li')).toHaveLength(value);
    }
    const text = t.els['chiffres-corps']!.textContent;
    expect(text).toContain('Contacts reçus');
    expect(text).toContain('Rendez-vous d’estimation');
    expect(text).toContain('Aucune ligne sur la période.');
    expect(text).toContain('12 345,67 €');
    expect(text).toContain('due, acte signé');
    expect(text).not.toMatch(/\bdue\b(?!,)|estimation\b(?!,)|upcomingFees|prevue/);
    // Une fiche s'ouvre depuis la ligne d'un contact.
    expect(t.byText(t.els['chiffres-corps']!, 'Voir la fiche')).toBeDefined();
  });

  it('la période se choisit en un geste, le bouton choisi est annoncé, et l’onglet « Journée » ramène à la journée', async () => {
    const t = await run({ 'GET /v1/pilotage/mes-chiffres': ok(FIGURES) });
    await t.click(t.els['chiffres-ouvrir']);
    await t.click(t.els['chiffres-annee']);
    expect(t.els['chiffres-annee']!.attributes['aria-pressed']).toBe('true');
    expect(t.els['chiffres-mois']!.attributes['aria-pressed']).toBe('false');
    const last = t.calls.filter((c) => c.url.startsWith('/v1/pilotage/mes-chiffres')).at(-1)!;
    const [, from, to] = /du=(\d{4}-\d{2}-\d{2})&au=(\d{4}-\d{2}-\d{2})/.exec(last.url)!;
    expect((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000).toBe(364);
    // DS005 · « Mes chiffres » est un onglet : on le quitte par un autre onglet, plus par un retour.
    await t.click(t.els['journee-ouvrir']);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els['chiffres-corps']!.children).toHaveLength(0);
  });

  it('hors réseau ou refusé : un message clair, rien d’affiché', async () => {
    const t = await run();
    await t.click(t.els['chiffres-ouvrir']);
    expect(t.els['chiffres-etat']!.textContent).toBe('Pas de réseau.Réessayer');
    expect(t.els['chiffres-etat']!.children[0]!.className).toBe('alerte');
    t.table['GET /v1/pilotage/mes-chiffres'] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.click(t.els['chiffres-mois']);
    expect(t.els['chiffres-etat']!.textContent).toBe('Indisponible pour le moment.Réessayer');
    expect(t.els['chiffres-corps']!.children).toHaveLength(0);
  });
});

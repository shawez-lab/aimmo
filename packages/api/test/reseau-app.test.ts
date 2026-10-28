import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { pilotageRoutes } from '../src/pilotage.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : identifiants, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const NETWORK = {
  from: '2027-06-01',
  to: '2027-06-30',
  totals: { contacts: 5, appointments: 2, mandates: 1, sales: 1 },
  // Dans l'ordre des identifiants, tel que le socle le donne : a1 a moins de ventes que a2, il reste devant [R14].
  byAgent: [
    { agentId: null, contacts: 1, appointments: 0, mandates: 0, sales: 0 },
    { agentId: 'a1', contacts: 1, appointments: 1, mandates: 0, sales: 0 },
    { agentId: 'a2', contacts: 3, appointments: 1, mandates: 1, sales: 1 },
  ],
  byZone: [
    { zone: null, contacts: 1, appointments: 0, mandates: 0, sales: 0 },
    { zone: 'Dijon', contacts: 4, appointments: 2, mandates: 1, sales: 1 },
  ],
  bySource: { contacts: [{ channel: 'instagram', count: 2 }, { channel: 'site', count: 3 }], mandates: [{ source: 'online_valuation', count: 1 }] },
  aiCosts: { totalCents: 1250, byChannel: [{ channel: 'instagram', cents: 1000 }, { channel: 'email', cents: 250 }], perSignedMandateCents: 1250 },
};
const ALERTS = [
  { key: 'budget_ia:2027-06', kind: 'budget_ia', data: { month: '2027-06', thresholdBp: 7000 }, createdAt: '2027-06-20T04:00:00.000Z' },
  { key: 'baisse:contacts:2027-W25', kind: 'baisse_indicateur', data: { indicator: 'contacts', last7: 2, previous28: 20, thresholdBp: 3000 }, createdAt: '2027-06-21T04:00:00.000Z' },
  { key: 'document:a1:assurance_rcp:2027-07-01', kind: 'document_agent', data: { agentId: 'a1', document: 'assurance_rcp', validUntil: '2027-07-01' }, createdAt: '2027-06-22T04:00:00.000Z' },
  { key: 'x', kind: INJECTED, data: {}, createdAt: '2027-06-22T04:00:00.000Z' },
];
const PAYOUTS = [
  { fileId: 'f1', receivedAt: '2027-06-18T09:00:00.000Z', payoutDueAt: '2027-06-21T09:00:00.000Z', alerts: ['avant_echeance', 'echeance_depassee'] },
  { fileId: 'f2', receivedAt: '2027-06-25T09:00:00.000Z', payoutDueAt: '2027-06-28T09:00:00.000Z', alerts: [] },
];
const DRAFTS = [
  { id: 'd1', fileId: 'f1', kind: 'honoraires', issuer: 'reseau', amountCents: 1200000, vatBp: 2000, createdAt: '2027-06-17T09:00:00.000Z' },
  { id: 'd2', fileId: 'f1', kind: 'reversement', issuer: 'agent:a2', amountCents: 600000, vatBp: 0, createdAt: '2027-06-17T09:00:00.000Z' },
];
const DIRECTION: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/pilotage/reseau': ok(NETWORK),
  'GET /v1/pilotage/alertes': ok(ALERTS),
  'GET /v1/pilotage/reversements': ok(PAYOUTS),
  'GET /v1/pilotage/factures/brouillons': ok(DRAFTS),
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, base: Record<string, Answer> = DIRECTION) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; authorization?: string | undefined }[] = [];
  const blobs: Blob[] = [];
  const links: FakeElement[] = [];
  const table: Record<string, Answer> = { ...base, ...answers };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document: { ...document, body, createElement: (tag: string) => { const e = document.createElement(tag); if (tag === 'a') links.push(e); return e; } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, authorization: init.headers?.authorization });
      const a = table[`${method} ${url}`] ?? table[`${method} ${url.split('?')[0]}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    URL: { createObjectURL: (b: Blob) => (blobs.push(b), 'blob:essai'), revokeObjectURL: () => undefined },
    setTimeout,
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
  return { els, calls, table, byText, click, blobs, body, links, storage };
}

const figures = (root: FakeElement) => root.all().filter((e) => e.tagName === 'details');
const value = (d: FakeElement) => d.all().find((e) => e.className === 'valeur')!.textContent;
const lines = (d: FakeElement) => d.all().filter((e) => e.tagName === 'li').map((e) => e.textContent);

describe('K09 · écran « Le réseau » pour la direction', () => {
  it('la direction arrive sur le réseau, pas sur la journée d’un agent ; chaque total égale la somme de ses lignes [R69]', async () => {
    const t = await run();
    expect(t.els.reseau!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    expect(t.els.connexion!.hidden).toBe(true);
    expect(t.calls.some((c) => c.url.startsWith('/v1/plan-du-jour'))).toBe(false);
    expect(t.calls.find((c) => c.url.startsWith('/v1/pilotage/reseau'))!.url).toMatch(/^\/v1\/pilotage\/reseau\?du=\d{4}-\d{2}-01&au=\d{4}-\d{2}-\d{2}$/);
    const all = figures(t.els['reseau-corps']!);
    // 4 par agent, 4 par commune, 2 par origine, 1 pour l'IA.
    expect(all).toHaveLength(11);
    for (const d of all) {
      const sum = lines(d).reduce((a, l) => a + Number(/: ([\d\s,]+)/.exec(l)![1]!.replace(/\s/g, '').replace(',', '.')), 0);
      const total = Number(value(d).replace(/[^\d,]/g, '').replace(',', '.'));
      expect(sum).toBeCloseTo(total, 2);
      expect(d.textContent).toContain('Total égal à la somme des lignes.');
    }
    const text = t.els['reseau-corps']!.textContent;
    expect(text).toContain('Direction, sans agent : 1');
    expect(text).toContain('Sans commune : 1');
    expect(text).toContain('Instagram : 2');
    expect(text).toContain('estimation en ligne : 1');
    expect(text).toContain('12,50 €');
    expect(text).toContain('Par mandat signé : 12,50 €.');
  });

  it('les agents restent dans l’ordre de leur identifiant, sans rang ni note [R14]', async () => {
    const t = await run();
    const sales = figures(t.els['reseau-corps']!).find((d) => d.textContent.startsWith('Vente'))!;
    expect(lines(sales)).toEqual(['Direction, sans agent : 0', 'Agent a1 : 0', 'Agent a2 : 1']);
    const text = ['reseau-corps', 'reseau-alertes', 'reseau-reversements', 'reseau-brouillons'].map((id) => t.els[id]!.textContent).join(' ');
    expect(text).toContain('sans rang ni note');
    expect(text).not.toMatch(/meilleur|classement|top\b|1er|score|note de l/i);
  });

  it('un écart entre un total et ses lignes est dit, jamais caché [R69]', async () => {
    const t = await run({ 'GET /v1/pilotage/reseau': ok({ ...NETWORK, totals: { ...NETWORK.totals, contacts: 6 } }) });
    expect(t.els['reseau-corps']!.textContent).toContain('Écart : la somme des lignes fait 5. À signaler.');
  });

  it('alertes, reversements et factures à valider, en français, sans code interne ni texte posé comme du code', async () => {
    const t = await run();
    const alerts = t.els['reseau-alertes']!.textContent;
    expect(alerts).toContain('Le coût de l’IA du mois atteint 70 % du budget réglé.');
    expect(alerts).toContain('Baisse sur les contacts reçus : 2 sur les 7 derniers jours, contre 20 sur les 28 précédents.');
    expect(alerts).toContain('assurance de responsabilité civile professionnelle, valable jusqu’au 01/07/2027');
    expect(alerts).toContain('Alerte de pilotage.');
    expect(alerts).not.toMatch(/budget_ia|baisse_indicateur|assurance_rcp|<img/);
    const payouts = t.els['reseau-reversements']!.textContent;
    expect(payouts).toContain('Dossier f1');
    expect(payouts).toContain('Échéance dépassée.');
    expect(t.els['reseau-reversements']!.all().filter((e) => e.className === 'retard')).toHaveLength(1);
    const drafts = t.els['reseau-brouillons']!.textContent;
    expect(drafts).toContain('Honoraires émis par le réseau : 12 000,00 € toutes taxes, TVA 20 %');
    expect(drafts).toContain('Reversement émis par l’agent a2 : 6 000,00 € toutes taxes, TVA 0 %');
  });

  it('une facture ne s’émet qu’au second geste, une seule fois, et le refus du socle est dit [R71]', async () => {
    const t = await run({ 'POST /v1/pilotage/factures/brouillons/d1/valider': ok({ id: 'i1', content: { label: 'Facture 2027-0001' } }), 'POST /v1/pilotage/factures/brouillons/d2/valider': no(409, { ok: false, rule: 'R71', code: 'sale_cancelled' }) });
    const box = t.els['reseau-brouillons']!;
    await t.click(t.byText(box, 'Valider cette facture'));
    expect(t.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(box.textContent).toContain('Une fois émise, elle ne change plus.');
    const confirm = t.byText(box, 'Confirmer : émettre la facture')!;
    await t.click(confirm);
    expect(t.calls.filter((c) => c.method === 'POST' && c.url === '/v1/pilotage/factures/brouillons/d1/valider')).toHaveLength(1);
    expect(box.textContent).toContain('Facture émise en mode essai : Facture 2027-0001.');
    expect(t.byText(box, 'Confirmer : émettre la facture')).toBeUndefined();
    await t.click(t.byText(box, 'Valider cette facture'));
    await t.click(t.byText(box, 'Confirmer : émettre la facture'));
    expect(box.textContent).toContain('La vente est annulée par un avoir : plus aucune facture ne s’émet.');
  });

  it('l’export du jour se télécharge avec la clé dans l’en-tête, jamais dans l’adresse [R13]', async () => {
    const t = await run({ 'GET /v1/pilotage/export-quotidien': async () => new Response('jour;contacts\n2027-06-20;3\n', { headers: { 'content-type': 'text/csv' } }) });
    expect(t.els['reseau-export-jour']!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    t.els['reseau-export-jour']!.value = '2027-06-20';
    await t.click(t.els['reseau-export']);
    const call = t.calls.find((c) => c.url.startsWith('/v1/pilotage/export-quotidien'))!;
    expect(call.url).toBe('/v1/pilotage/export-quotidien?jour=2027-06-20');
    expect(call.url).not.toContain(KEY);
    expect(call.authorization).toBe(`Bearer ${KEY}`);
    expect(await t.blobs[0]!.text()).toContain('2027-06-20;3');
    expect(t.els['reseau-export-etat']!.textContent).toBe('Export du 20/06/2027 téléchargé.');
    expect(t.links).toHaveLength(1);
    expect(t.links[0]!.clicks).toBe(1);
    expect((t.links[0] as unknown as { download: string }).download).toBe('chiffres-2027-06-20.csv');
    expect(t.body.children).toHaveLength(0);
    t.els['reseau-export-jour']!.value = '';
    await t.click(t.els['reseau-export']);
    expect(t.els['reseau-export-etat']!.textContent).toBe('Choisissez un jour.');
  });

  it('la période se choisit en un geste ; hors réseau, un message clair et rien d’affiché', async () => {
    const t = await run();
    await t.click(t.els['reseau-annee']);
    expect(t.els['reseau-annee']!.attributes['aria-pressed']).toBe('true');
    const last = t.calls.filter((c) => c.url.startsWith('/v1/pilotage/reseau')).at(-1)!;
    const [, from, to] = /du=(\d{4}-\d{2}-\d{2})&au=(\d{4}-\d{2}-\d{2})/.exec(last.url)!;
    expect((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000).toBe(364);
    delete t.table['GET /v1/pilotage/reseau'];
    await t.click(t.els['reseau-mois']);
    expect(t.els['reseau-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.els['reseau-corps']!.children).toHaveLength(0);
  });

  it('une clé refusée au téléchargement de l’export efface la clé et tout l’écran [R16]', async () => {
    const t = await run({ 'GET /v1/pilotage/export-quotidien': no(401, { ok: false, code: 'unauthorized' }) });
    expect(t.els['reseau-corps']!.children.length).toBeGreaterThan(0);
    await t.click(t.els['reseau-export']);
    expect(t.els.connexion!.hidden).toBe(false);
    expect(t.els.reseau!.hidden).toBe(true);
    expect(t.storage.has('aimmo.cle')).toBe(false);
    expect(t.els['reseau-corps']!.children).toHaveLength(0);
    expect(t.blobs).toHaveLength(0);
  });

  it('se déconnecter efface tout l’écran du réseau', async () => {
    const t = await run();
    await t.click(t.els.sortir);
    expect(t.els.connexion!.hidden).toBe(false);
    expect(t.els.reseau!.hidden).toBe(true);
    for (const id of ['reseau-corps', 'reseau-alertes', 'reseau-reversements', 'reseau-brouillons']) expect(t.els[id]!.children).toHaveLength(0);
  });

  it('chaque adresse appelée par l’écran est une route de `/v1/pilotage` [R16]', async () => {
    const t = await run({ 'POST /v1/pilotage/factures/brouillons/d1/valider': ok({}), 'GET /v1/pilotage/export-quotidien': async () => new Response('x') });
    await t.click(t.byText(t.els['reseau-brouillons']!, 'Valider cette facture'));
    await t.click(t.byText(t.els['reseau-brouillons']!, 'Confirmer : émettre la facture'));
    await t.click(t.els['reseau-export']);
    const routes = pilotageRoutes();
    const pilotageCalls = t.calls.filter((c) => c.url.startsWith('/v1/pilotage/'));
    expect(pilotageCalls.length).toBeGreaterThanOrEqual(6);
    for (const c of pilotageCalls) {
      const path = c.url.slice(3).split('?')[0]!;
      expect(routes.some((r) => r.method === c.method && r.pattern.test(path)), `${c.method} ${path}`).toBe(true);
    }
  });
});

describe('K09 · un agent garde son écran, sans rien du réseau [R68]', () => {
  const AGENT: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/plan-du-jour': ok(null),
    'GET /v1/contacts-chauds': ok({ contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
    'GET /v1/usage/matin': ok(null),
    'GET /v1/annonces': ok([]),
    'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
    ...Object.fromEntries(Object.entries(DIRECTION).filter(([k]) => k.startsWith('GET /v1/pilotage'))),
  };

  it('l’agent arrive sur sa journée ; aucune route du réseau n’est appelée', async () => {
    const t = await run({}, AGENT);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els.reseau!.hidden).toBe(true);
    expect(t.els.bonjour!.textContent).toBe('Bonjour Alex');
    expect(t.calls.some((c) => /^\/v1\/pilotage\/(reseau|alertes|reversements|factures)/.test(c.url))).toBe(false);
    expect(t.els['reseau-corps']!.children).toHaveLength(0);
  });

  it('les autres rôles restent refusés par l’application', async () => {
    for (const role of ['compliance', 'partner']) {
      const t = await run({ 'GET /v1/moi': ok({ role, firstName: null }) });
      expect(t.els.connexion!.hidden).toBe(false);
      expect(t.els.erreur!.textContent).toBe('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
      expect(t.calls.some((c) => c.url.startsWith('/v1/pilotage'))).toBe(false);
    }
  });
});

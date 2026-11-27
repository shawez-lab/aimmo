import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : dossiers, clients, clé de test.
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
      const a = table[`${method} ${url}`];
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

describe('F07 · après la vente dans l’application', () => {
  it('« Ma journée » : les appels pour remercier, le proche recommandé, la tâche du lien ; tout texte reste du texte', async () => {
    const t = await run();
    const items = t.els['apres-jour']!.children.map((li) => li.textContent);
    expect(items[0]).toBe('Appeler pour remercier : Vendeur · LéaBien REF-T-1');
    expect(items[1]).toContain(`Appeler ${INJECTED}, recommandé par un client`);
    expect(items[2]).toBe('Réglez le lien de votre fiche Google : sans lui, aucune demande d’avis ne part.Bien REF-T-1');
    t.table['POST /v1/apres-vente/appels/r1/fait'] = ok(null);
    await t.click(t.byText(t.els['apres-jour']!, 'Appel fait'));
    expect(t.calls.at(-1)).toEqual({ method: 'POST', url: '/v1/apres-vente/appels/r1/fait' });
    expect(t.els['apres-jour']!.children[1]!.textContent).toContain('Appel fait');
    expect(t.byText(t.els['apres-jour']!, 'Appel fait')).toBeUndefined();
  });

  it('l’écran des ventes conclues : par client, le remerciement à valider, la demande d’avis, les nouvelles, la note', async () => {
    const t = await run();
    await t.click(t.els['apres-ouvrir']);
    expect(t.els.apres!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    const text = t.els['apres-corps']!.textContent;
    expect(text).toContain('Bien REF-T-1, Dijon');
    expect(text).toContain('Vendeur · Léa');
    expect(text).toContain(`Bonjour Léa, merci ${INJECTED}`);
    expect(text).toContain('Demande d’avis : partie (mode essai)');
    expect(text).toContain('Demande d’avis : bloquée par le contrôle des envois');
    expect(text).toContain('Nouvelles à 1 an : partie (mode essai)');
    expect(text).toContain('message validé, attend le prochain créneau permis');
    expect(text).toContain('5 sur 5');
    expect(text).toContain(`Parfait ${INJECTED}`);
    expect(text).not.toMatch(/\bsent\b|refused|waiting|vendeur\b/);
    t.table['POST /v1/apres-vente/dossiers/f1/clients/p1/remerciement'] = ok({ status: 'sent' });
    await t.click(t.byText(t.els['apres-corps']!, 'Envoyer ce message'));
    expect(t.calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/v1/apres-vente/dossiers/f1/clients/p1/remerciement', body: JSON.stringify({ decision: 'send' }) });
    expect(t.calls.at(-1)).toEqual({ method: 'GET', url: '/v1/apres-vente/dossiers' });
    expect(t.els['apres-etat']!.textContent).toBe('Enregistré.');
  });

  it('le lien de la fiche Google, un refus dit en clair, et le retour à la journée', async () => {
    const t = await run();
    await t.click(t.els['apres-ouvrir']);
    await t.click(t.byText(t.els['apres-corps']!, 'Enregistrer le lien'));
    expect(t.els['apres-etat']!.textContent).toBe('Saisissez d’abord l’adresse.');
    const input = t.els['apres-corps']!.all().find((e) => e.attributes.id === 'lien-avis')!;
    input.value = 'https://exemple.test/pas-google';
    t.table['POST /v1/apres-vente/lien-avis'] = no(400, { ok: false, rule: null, code: 'bad_link' });
    await t.click(t.byText(t.els['apres-corps']!, 'Enregistrer le lien'));
    expect(t.calls.at(-1)).toEqual({ method: 'POST', url: '/v1/apres-vente/lien-avis', body: JSON.stringify({ url: 'https://exemple.test/pas-google' }) });
    expect(t.els['apres-etat']!.textContent).toBe('Ce lien n’est pas celui d’une fiche Google.');
    await t.click(t.els['apres-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els['apres-corps']!.children).toHaveLength(0);
  });

  it('sans vente conclue : dit simplement ; hors ligne : dit sans rien effacer', async () => {
    const empty = await run({ 'GET /v1/apres-vente/dossiers': ok([]), 'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }) });
    expect(empty.els['apres-jour-etat']!.textContent).toBe('Rien à faire après vos ventes aujourd’hui.');
    await empty.click(empty.els['apres-ouvrir']);
    expect(empty.els['apres-etat']!.textContent).toBe('Aucune vente conclue pour le moment.');
    const offline = await run({ 'GET /v1/apres-vente/dossiers': () => Promise.reject(new TypeError('hors ligne')) });
    await offline.click(offline.els['apres-ouvrir']);
    // DS061 · hors ligne se voit dans un bandeau, avec « Réessayer ».
    expect(offline.els['apres-etat']!.textContent).toBe('Pas de réseau.Réessayer');
    expect(offline.els['apres-etat']!.children[0]!.className).toBe('alerte');
    expect(offline.storage.get('aimmo.cle')).toBe(KEY);
  });
});

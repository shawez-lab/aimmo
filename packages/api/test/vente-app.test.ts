import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : bien, annonce, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const CHECK = {
  complete: false,
  publishedPriceEur: 210000,
  text: '',
  items: [
    { id: 'prix', status: 'presente', text: '210 000 € honoraires inclus' },
    { id: 'energie', status: 'manquante', reason: 'pas_de_diagnostic' },
    { id: 'copropriete', status: 'sans_objet' },
  ],
};
const DRAFT = {
  id: 'd2',
  propertyId: 'b1',
  seq: 2,
  title: 'Appartement lumineux à Dijon',
  body: '',
  origin: 'secours',
  sheetVersion: 1,
  sentences: [
    { text: `Appartement de 62 m² ${INJECTED}.`, sources: [{ field: 'surfaceM2', value: '62 m²' }], problems: [] },
    { text: 'Proche de la gare.', sources: [], problems: [{ code: 'fait_sans_source', value: 'gare' }] },
  ],
  createdBy: 'agent:a1',
  createdAt: '2027-02-12T10:00:00.000Z',
  validated: null,
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null }]),
  'GET /v1/annonces/b1/controle': ok(CHECK),
  'GET /v1/annonces/b1/brouillon': ok(DRAFT),
  'GET /v1/annonces/b1/publication': ok(null),
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
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

describe('P10 · écran « Mettre en vente »', () => {
  it('depuis la journée : la liste de contrôle, l’annonce phrase par phrase avec la source de chaque nombre, et la validation', async () => {
    const t = await run();
    expect(t.els.biens!.children.map((li) => li.textContent)).toEqual(['REF-T-1 · DijonPas encore publiée.Mettre en venteStudio']);
    await t.click(t.byText(t.els.biens!, 'Mettre en vente'));
    expect(t.els.vente!.hidden).toBe(false);
    expect(t.els['vente-titre']!.textContent).toBe('Mettre en vente · REF-T-1');
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('Il manque des mentions : l’annonce ne peut pas partir.');
    expect(text).toContain('Prix et honoraires : présente');
    expect(text).toContain('Performance énergétique : manque, diagnostic énergétique absent');
    expect(text).toContain('Copropriété : sans objet');
    expect(text).toContain('62 m² : surface, lu dans la fiche du bien');
    expect(text).toContain('À corriger : fait absent de la fiche (« gare »)');
    expect(text).toContain(INJECTED);
    expect(text).not.toMatch(/pas_de_diagnostic|fait_sans_source|surfaceM2|sans_objet/);
    expect(text).toContain('Pas encore publiée : elle part d’elle-même au passage suivant');
    t.table['POST /v1/annonces/brouillons/d2/validation'] = no(409, { ok: false, rule: 'R43', code: 'mentions_incomplete', missing: [] });
    await t.click(t.byText(t.els['vente-corps']!, 'Valider l’annonce'));
    expect(t.calls.at(-1)).toEqual({ method: 'POST', url: '/v1/annonces/brouillons/d2/validation' });
    expect(t.els['vente-etat']!.textContent).toBe('Il manque des mentions obligatoires : complétez la fiche du bien.');
  });

  it('sans annonce : « Rédiger l’annonce » ; publiée : la version, le prix et chaque canal', async () => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': no(404, { ok: false, rule: null, code: 'no_draft' }) });
    await t.click(t.byText(t.els.biens!, 'Mettre en vente'));
    expect(t.els['vente-corps']!.textContent).toContain('Aucune annonce rédigée pour ce bien.');
    t.table['POST /v1/annonces/b1/brouillon'] = ok({ ...DRAFT, validated: null });
    t.table['GET /v1/annonces/b1/brouillon'] = ok({ ...DRAFT, validated: { by: 'agent:a1', at: '2027-02-12T10:05:00.000Z' } });
    t.table['GET /v1/annonces/b1/publication'] = ok({ version: 1, state: 'en_vente', priceEur: 210000, channels: { site: 'publiee', reseaux: 'en_attente', google: 'echec', portails: 'publiee' } });
    await t.click(t.byText(t.els['vente-corps']!, 'Rédiger l’annonce'));
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('Annonce validée le 12/02/2027.');
    expect(text).toContain('Version 1, en vente');
    expect(text).toContain('réseaux sociaux : en attente');
    expect(text).toContain('fiche Google : en échec, reprise au passage suivant');
    expect(t.byText(t.els['vente-corps']!, 'Valider l’annonce')).toBeUndefined();
  });

  it('une lecture en échec n’est jamais montrée comme un état vide, et aucun geste n’est proposé dessus', async () => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': no(500, { ok: false, code: 'internal_error' }), 'GET /v1/annonces/b1/publication': () => Promise.reject(new TypeError('hors ligne')) });
    await t.click(t.byText(t.els.biens!, 'Mettre en vente'));
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('L’annonce n’a pas pu être lue.');
    expect(text).toContain('L’état de la publication n’a pas pu être lu.');
    expect(text).not.toMatch(/Aucune annonce rédigée|Pas encore publiée/);
    expect(t.byText(t.els['vente-corps']!, 'Rédiger l’annonce')).toBeUndefined();
  });

  it('[R16] un bien hors des droits est dit ; une clé refusée efface tout', async () => {
    const denied = await run({ 'GET /v1/annonces/b1/controle': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await denied.click(denied.byText(denied.els.biens!, 'Mettre en vente'));
    expect(denied.els['vente-etat']!.textContent).toBe('Ce bien n’est pas dans vos droits.');
    const refused = await run({ 'GET /v1/annonces/b1/controle': no(401, { ok: false, code: 'unauthorized' }) });
    await refused.click(refused.byText(refused.els.biens!, 'Mettre en vente'));
    expect(refused.els.connexion!.hidden).toBe(false);
    expect(refused.storage.has('aimmo.cle')).toBe(false);
    expect(refused.els['vente-corps']!.children).toEqual([]);
  });
});

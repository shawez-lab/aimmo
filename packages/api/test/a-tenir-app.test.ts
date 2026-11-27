import { runInNewContext } from 'vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { A_TENIR_SCRIPT } from '../app/a-tenir.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const FILE = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '22222222-2222-4222-8222-222222222222';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const EMPTY = { fonds: [], financement: [], echeances: [] };
const FULL = {
  fonds: [{ fileId: FILE, propertyId: PROPERTY, reference: 'REF-1', side: 'acquereur', subjects: ['numéro de compte', 'virement'], messages: 2, lastAt: '2027-03-08T10:00:00.000Z', reminder: 'a_prevenir' }],
  financement: [{ fileId: FILE, propertyId: PROPERTY, reference: 'REF-1', kind: 'refus_declare', day: '2027-03-19' }],
  echeances: [
    { source: 'offre', propertyId: PROPERTY, reference: INJECTED, proposal: true, day: '2027-03-20' },
    { source: 'dossier', fileId: FILE, propertyId: PROPERTY, reference: 'REF-1', deadline: 'date_limite_pret', kind: 'avant_echeance', day: '2027-04-30' },
    { source: 'dossier', fileId: FILE, propertyId: PROPERTY, reference: 'REF-1', deadline: 'acte', kind: 'a_saisir', day: null },
  ],
};

async function run(answer: Answer | null) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: string[] = [];
  const context: Record<string, unknown> = {
    document,
    Date,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string) => {
      calls.push(url);
      if (url === '/v1/moi') return Promise.resolve(Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }));
      if (url === '/v1/offres/a-tenir') return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
      return Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, context);
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const scripts = () => els.accueil!.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/a-tenir.js');
  const load = async () => {
    const s = scripts();
    expect(s).toHaveLength(1);
    runInNewContext(A_TENIR_SCRIPT, context);
    s[0]!.listeners.load!({});
    await tick();
  };
  const buttons = (): FakeElement[] => els['a-tenir']!.all().filter((e) => e.tagName === 'button');
  return { els, calls, tick, scripts, load, buttons };
}

describe('W26 · à tenir sur mes ventes, à l’accueil', () => {
  it('[R10] rien à tenir : c’est dit, et le dessin n’est pas chargé [R201]', async () => {
    const t = await run(ok(EMPTY));
    expect(t.calls).toContain('/v1/offres/a-tenir');
    expect(t.els['a-tenir-etat']!.textContent).toBe('Rien à tenir pour le moment.');
    expect(t.scripts()).toEqual([]);
  });

  it('[R62] [R15] le message sur l’argent vient d’abord, dit quoi faire et ce que devient le rappel', async () => {
    const t = await run(ok(FULL));
    expect(t.els['a-tenir-etat']!.textContent).toBe('Chargement…');
    await t.load();
    expect(t.els['a-tenir-etat']!.textContent).toBe('');
    const items = t.els['a-tenir']!.all().filter((e) => e.tagName === 'li');
    expect(items).toHaveLength(5);
    expect(items[0]!.className).toBe('alerte');
    const first = items[0]!.textContent;
    expect(first).toContain('Bien REF-1 : un message de l’acquéreur parle d’argent');
    expect(first).toContain('2 messages, le dernier le 08/03/2027');
    expect(first).toContain('Sujets repérés : numéro de compte, virement.');
    expect(first).toContain('Prévenez-le vous-même');
  });

  it('[R62] rien ne laisse croire que le client est prévenu : aucun rappel ne dispense l’agent, en mode essai', async () => {
    for (const reminder of ['fait', 'attente', 'a_prevenir', 'inconnu']) {
      const t = await run(ok({ ...EMPTY, fonds: [{ ...FULL.fonds[0], reminder }] }));
      await t.load();
      expect(t.els['a-tenir']!.textContent).toContain('Prévenez-le vous-même.');
    }
  });

  it('[R59] [R61] chaque échéance est nommée, avec son bien, son jour ou la date à saisir ; un texte reçu reste du texte', async () => {
    const t = await run(ok(FULL));
    await t.load();
    const text = t.els['a-tenir']!.textContent;
    expect(text).toContain('Refus de prêt déclaré le 19/03/2027.');
    expect(text).toContain('Proposition sans réponse : dernier jour le 20/03/2027.');
    expect(text).toContain('Date limite du prêt : le 30/04/2027.');
    expect(text).toContain('Acte : date à saisir.');
    expect(text).toContain(`Bien ${INJECTED}`);
    expect(t.els['a-tenir']!.all().filter((e) => e.tagName === 'img')).toEqual([]);
  });

  it('[R16] chaque ligne ouvre l’écran qui la règle, avec son nom pour le lecteur d’écran', async () => {
    const t = await run(ok(FULL));
    await t.load();
    const b = t.buttons();
    expect(b.map((x) => x.textContent)).toEqual(['Voir le dossier', 'Voir le dossier', 'Voir les offres', 'Voir le dossier', 'Voir le dossier']);
    expect(b[0]!.attributes['aria-label']).toBe('Voir le dossier : Bien REF-1');
    void b[0]!.listeners.click!({});
    await t.tick();
    expect(t.els.dossier!.all().some((e) => e.tagName === 'script' && e.attributes.src === '/app/dossier.js')).toBe(true);
  });

  it('[R16] un identifiant mal formé n’ouvre rien', async () => {
    const t = await run(ok({ ...EMPTY, financement: [{ fileId: '../x', propertyId: 'y', reference: 'REF-2', kind: 'refus_declare', day: '2027-03-19' }] }));
    await t.load();
    expect(t.buttons()).toEqual([]);
  });

  it('[R10] une lecture manquée n’est jamais « rien à tenir » : réseau coupé, panne ou réponse sans listes', async () => {
    for (const answer of [null, async () => new Response('panne', { status: 500 }), ok(null), ok({ fonds: [] })]) {
      const t = await run(answer);
      // DS061 · la panne se voit, avec « Réessayer » : un bandeau, pas une phrase grise.
      const alert = t.els['a-tenir-etat']!.children[0]!;
      expect(alert.className).toBe('alerte');
      expect(t.els['a-tenir-etat']!.textContent).toBe('Indisponible pour le moment.Réessayer');
      expect(t.els['a-tenir']!.all().filter((e) => e.tagName === 'li')).toEqual([]);
    }
  });

  it('[R16] une clé refusée vide l’accueil, comme les autres lectures', async () => {
    const t = await run(async () => Response.json({ ok: false, rule: 'R16', code: 'agent_inactive' }, { status: 403 }));
    expect(t.els.connexion!.hidden).toBe(false);
    expect(t.els['a-tenir-etat']!.textContent).toBe('');
  });

  it('[R10] le dessin qui n’arrive pas se dit', async () => {
    const t = await run(ok(FULL));
    t.scripts()[0]!.listeners.error!({});
    expect(t.els['a-tenir-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R201] le dessin est servi à part, jamais gardé sur l’appareil, et tient le budget d’une page ; l’application tient le sien', () => {
    expect(AGENT_APP_FILES['/app/a-tenir.js']).toBe(A_TENIR_SCRIPT);
    expect(A_TENIR_SCRIPT).not.toContain('innerHTML');
    expect(AGENT_APP_SHELL).not.toContain('/app/a-tenir.js');
    expect(budgetProblems({ html: '', js: A_TENIR_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
  });
});

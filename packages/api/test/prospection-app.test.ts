import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { PROSPECTION_SCRIPT } from '../app/prospection.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, entreprises, adresses, sources.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const LIST = [
  { prospectId: 'p2', trade: 'notaire', businessName: 'Zèbre Notaires', source: 'Annuaire public inventé', addedAt: '2027-07-01T08:00:00.000Z', mailedOn: '2027-07-12', opposed: false },
  { prospectId: 'p1', trade: 'courtier', businessName: 'Abeille Courtage', source: 'Site public inventé', addedAt: '2027-07-02T08:00:00.000Z', mailedOn: null, opposed: false },
  { prospectId: 'p3', trade: 'artisan', businessName: 'Castor Travaux', source: 'Registre public inventé', addedAt: '2027-07-03T08:00:00.000Z', mailedOn: null, opposed: true },
];
const DRAFTS = [
  { prospectId: 'p2', day: '2027-07-12', text: 'Bonjour, AIMMO Essai est un réseau d’agents immobiliers.', decisionRule: 'R03' },
  { prospectId: 'p9', day: '2027-07-12', text: 'Bonjour, un autre brouillon.', decisionRule: null },
];
const BASE = '/v1/partenaires/prospection';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const MAILS = `${BASE}/mails?jour=${TODAY}`;
let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    [`GET ${BASE}`]: ok(LIST),
    [`GET ${MAILS}`]: ok(DRAFTS),
    [`POST ${BASE}`]: ok({ ...LIST[1] }),
    [`POST ${BASE}/p1/opposition`]: ok(true),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: unknown } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['prospection-corps']!;
  const state = () => els['prospection-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/prospection.js');
  const open = async () => {
    await click(els['prospection-ouvrir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(PROSPECTION_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const fill = () => {
    input('prospection-metier').value = 'courtier';
    input('prospection-nom').value = ' Abeille Courtage ';
    input('prospection-mail').value = ' contact@abeille-essai.example ';
    input('prospection-sorte').value = 'professionnelle';
    input('prospection-source').value = ' Site public inventé ';
  };
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith(BASE));
  return { els, calls, table, body, state, texts, find, input, click, open, fill, posts, scripts };
}

describe('U14 · la prospection des partenaires à l’écran', () => {
  it('le script ne se charge qu’au premier geste', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith(BASE))).toBe(false);
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === BASE)).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === MAILS)).toHaveLength(1);
  });

  it('[R14] la liste garde l’ordre reçu, dit où en est chacun, sans note ni rang', async () => {
    const t = await run();
    await t.open();
    const names = t.body().all().filter((e) => e.tagName === 'strong').map((e) => e.textContent);
    expect(names.slice(0, 3)).toEqual(['Zèbre Notaires', 'Abeille Courtage', 'Castor Travaux']);
    expect(t.texts()).toContain('Source : Annuaire public inventé');
    expect(t.texts()).toContain('Premier mail préparé le 12/07/2027, sans envoi.');
    expect(t.texts()).toContain('Aucun mail préparé.');
    expect(t.texts()).toContain('Opposition notée : plus aucun message, pour toujours.');
    expect(t.texts()).not.toMatch(/\bnote\b|étoile|classement|\bavis\b|meilleur/i);
    // Un contact opposé n'a plus de geste.
    expect(t.find('Noter son opposition')).toHaveLength(2);
  });

  it('[R03] [R79] chaque brouillon dit son refus ; aucun geste d’envoi, et rien ne part à la lecture', async () => {
    const t = await run();
    await t.open();
    expect(t.texts()).toContain('Tant que la prospection entre professionnels n’est pas tranchée, le contrôle central refuse chaque premier mail sous la règle R03.');
    expect(t.texts()).toContain('Refusé par le contrôle central, règle R03 : il faut un accord préalable tant que la prospection entre professionnels n’est pas tranchée. Ce brouillon ne part pas.');
    expect(t.texts()).toContain('Bonjour, AIMMO Essai est un réseau d’agents immobiliers.');
    // Le nom vient de la liste ; sans refus rangé, l'écran ne dit jamais que c'est parti.
    expect(t.texts()).toContain('Il ne part pas d’ici : le contrôle central redécide au moment de l’envoi.');
    expect(t.texts()).toContain('Contact professionnel');
    expect(t.posts()).toEqual([]);
    const buttons = t.body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
    expect(buttons.filter((b) => /envoy|partir|valider/i.test(b))).toEqual([]);
    expect(PROSPECTION_SCRIPT).not.toMatch(/\/envoi|\/send|\/valider/);
  });

  it('[R03] une autre règle rangée est dite telle quelle', async () => {
    const t = await run({ [`GET ${MAILS}`]: ok([{ prospectId: 'p1', day: TODAY, text: 'Bonjour.', decisionRule: 'R04' }]) });
    await t.open();
    expect(t.texts()).toContain('Refusé par le contrôle central, règle R04. Ce brouillon ne part pas.');
  });

  it('un autre jour se lit ; un jour vide ne part pas ; aucun brouillon est dit', async () => {
    const t = await run({ [`GET ${BASE}/mails?jour=2027-07-13`]: ok([]) });
    await t.open();
    t.input('prospection-jour').value = '';
    await t.click(t.find('Lire ce jour')[0]);
    expect(t.texts()).toContain('Choisissez le jour à lire.');
    expect(t.texts()).not.toContain('Bonjour, un autre brouillon.');
    t.input('prospection-jour').value = '2027-07-13';
    await t.click(t.find('Lire ce jour')[0]);
    expect(t.texts()).toContain('Aucun brouillon préparé ce jour-là.');
    expect(t.calls.some((c) => c.url === `${BASE}/mails?jour=2027-07-13`)).toBe(true);
  });

  it('[R79] ajouter un contact : tout part nettoyé, la liste est relue, et rien ne lui est écrit', async () => {
    const t = await run();
    await t.open();
    t.fill();
    await t.click(t.find('Ajouter ce contact')[0]);
    expect(t.posts()).toEqual([{ method: 'POST', url: BASE, body: { email: 'contact@abeille-essai.example', addressKind: 'professionnelle', trade: 'courtier', businessName: 'Abeille Courtage', source: 'Site public inventé' } }]);
    expect(t.state()).toBe('Contact ajouté. Rien ne lui est écrit.');
    expect(t.calls.filter((c) => c.url === BASE && c.method === 'GET')).toHaveLength(2);
    // Le formulaire est refait à neuf : l'adresse ne reste pas à l'écran.
    expect(t.input('prospection-mail').value).toBe('');
  });

  it('[R79] une adresse personnelle ou non déclarée ne quitte pas l’appareil ; une saisie incomplète non plus', async () => {
    const t = await run();
    await t.open();
    const add = () => t.click(t.find('Ajouter ce contact')[0]);
    await add();
    expect(t.state()).toBe('Choisissez le métier.');
    t.fill();
    t.input('prospection-nom').value = 'A';
    await add();
    expect(t.state()).toContain('Le nom de l’entreprise');
    t.fill();
    t.input('prospection-mail').value = ' ';
    await add();
    expect(t.state()).toBe('L’adresse mail n’est pas lisible.');
    t.fill();
    t.input('prospection-sorte').value = '';
    await add();
    expect(t.state()).toBe('Dites si cette adresse est professionnelle.');
    t.input('prospection-sorte').value = 'personnelle';
    await add();
    expect(t.state()).toBe('Seule une adresse professionnelle se range ici, jamais une adresse personnelle.');
    t.fill();
    t.input('prospection-source').value = 'x';
    await add();
    expect(t.state()).toContain('La source publique');
    expect(t.posts()).toEqual([]);
  });

  it('[R04] [R05] [R79] les refus du serveur sont dits, le formulaire reste', async () => {
    for (const [status, code, rule, text] of [
      [409, 'opposed', 'R04', 'Cette adresse a demandé l’arrêt : elle ne revient jamais dans la liste.'],
      [409, 'already_listed', 'R05', 'Cette adresse est déjà dans la liste : elle ne reçoit jamais deux fois le premier mail.'],
      [409, 'not_professional', 'R79', 'Seule une adresse professionnelle se range ici, jamais une adresse personnelle.'],
      [400, 'bad_email', null, 'L’adresse mail n’est pas lisible.'],
      [400, 'autre', null, 'Le contact n’est pas ajouté.'],
    ] as const) {
      const t = await run({ [`POST ${BASE}`]: no(status, { ok: false, rule, code }) });
      await t.open();
      t.fill();
      await t.click(t.find('Ajouter ce contact')[0]);
      expect(t.state()).toBe(text);
      expect(t.input('prospection-nom').value).toContain('Abeille');
    }
  });

  it('[R04] l’opposition demande deux appuis espacés, puis relit la liste', async () => {
    clock = 100_000;
    const t = await run();
    await t.open();
    const b = t.find('Noter son opposition')[1]!;
    await t.click(b);
    expect(t.state()).toContain('cela ne se défait pas');
    expect(t.posts()).toEqual([]);
    // Trop tôt : rien. Un appui réfléchi : elle part.
    clock += 500;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    await t.click(b);
    expect(t.posts().map((c) => c.url)).toEqual([`${BASE}/p1/opposition`]);
    expect(t.state()).toBe('Opposition notée : plus aucun message.');
  });

  it('[R04] un premier appui trop ancien ne vaut plus', async () => {
    clock = 100_000;
    const t = await run();
    await t.open();
    const b = t.find('Noter son opposition')[1]!;
    await t.click(b);
    clock += 20_000;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    expect(b.textContent).toBe('Confirmer : noter son opposition');
  });

  it('[R10] un ajout ou une opposition sans réponse n’est dit ni fait ni refusé', async () => {
    const lostText = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.';
    for (const answer of [async () => { throw new TypeError('coupure'); }, no(500, { ok: false, code: 'panne' }), async () => new Response('pas du json', { status: 200 })] as Answer[]) {
      const t = await run({ [`POST ${BASE}`]: answer, [`POST ${BASE}/p1/opposition`]: answer });
      await t.open();
      t.fill();
      await t.click(t.find('Ajouter ce contact')[0]);
      expect(t.state()).toBe(lostText);
      clock = 100_000;
      const b = t.find('Noter son opposition')[1]!;
      await t.click(b);
      clock += 2000;
      await t.click(b);
      expect(t.state()).toBe(lostText);
      expect(t.calls.filter((c) => c.url === BASE && c.method === 'GET')).toHaveLength(1);
    }
  });

  it('[R10] ajouté, mais la liste n’est pas relue : le fait reste dit', async () => {
    const t = await run();
    await t.open();
    t.fill();
    t.table[`GET ${BASE}`] = async () => { throw new TypeError('coupure'); };
    await t.click(t.find('Ajouter ce contact')[0]);
    expect(t.state()).toBe('Contact ajouté. Rien ne lui est écrit. Pas de réseau. Réessayez dans un moment.');
  });

  it('[R10] des brouillons illisibles sont dits à part : la liste reste', async () => {
    const t = await run({ [`GET ${MAILS}`]: async () => { throw new TypeError('coupure'); } });
    await t.open();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect(t.texts()).toContain('Zèbre Notaires');
    expect(t.state()).toBe('');
  });

  it('[R16] un refus de droits est dit, sans rien montrer', async () => {
    const t = await run({ [`GET ${BASE}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    expect(t.body().children).toEqual([]);
    expect(t.calls.some((c) => c.url === MAILS)).toBe(false);
  });

  it('[R16] un refus de droits sur les brouillons est dit aussi', async () => {
    const t = await run({ [`GET ${MAILS}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.texts()).toContain('Ce n’est pas dans vos droits.');
    expect(t.texts()).not.toContain('Bonjour');
  });

  it('une réponse qui arrive après le jour suivant ne l’écrase pas', async () => {
    let release: (r: Response) => void = () => undefined;
    const slow: Answer = () => new Promise((r) => { release = r; });
    const t = await run({ [`GET ${BASE}/mails?jour=2027-07-13`]: slow, [`GET ${BASE}/mails?jour=2027-07-14`]: ok([]) });
    await t.open();
    t.input('prospection-jour').value = '2027-07-13';
    await t.click(t.find('Lire ce jour')[0]);
    t.input('prospection-jour').value = '2027-07-14';
    await t.click(t.find('Lire ce jour')[0]);
    release(Response.json({ ok: true, mode: 'essai', data: [{ prospectId: 'p1', day: '2027-07-13', text: 'Vieux brouillon.', decisionRule: 'R03' }] }));
    await settle();
    expect(t.texts()).not.toContain('Vieux brouillon.');
    expect(t.texts()).toContain('Aucun brouillon préparé ce jour-là.');
  });

  it('en sortant, rien ne reste à l’écran ; un script qui manque est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    await t.open();
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    const u = await run();
    await u.click(u.els['prospection-ouvrir']);
    u.scripts()[0]!.listeners.error!({});
    await settle();
    expect(u.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await u.click(u.els['prospection-ouvrir']);
    u.scripts()[1]!.listeners.load!({});
    await settle();
    expect(u.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('[R13] l’adresse n’est jamais relue à l’écran', async () => {
    const t = await run();
    await t.open();
    expect(t.texts()).not.toContain('@');
    expect(PROSPECTION_SCRIPT).not.toContain('localStorage');
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/prospection.js']).toBe(PROSPECTION_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/prospection.js');
    expect(handleAgentApp(new Request('https://x.test/app/prospection.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: PROSPECTION_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(PROSPECTION_SCRIPT).not.toContain('innerHTML');
  });
});

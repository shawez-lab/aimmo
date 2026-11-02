import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ALERTES_SCRIPT } from '../app/alertes.ts';
import { REPRISE_SCRIPT } from '../app/reprise.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const ALERTS = [
  { id: 'al-1', personId: 'p-1', firstName: 'Léa', reason: 'needs_reply', channel: 'email', createdAt: '2026-12-08T09:00:00.000Z', contactClosed: false },
  { id: 'al-2', personId: 'p-2', firstName: INJECTED, reason: 'exchanges', channel: 'instagram', createdAt: '2026-12-07T09:00:00.000Z', contactClosed: true },
];

async function run(routes: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { url: string; method: string; body?: string }[] = [];
  const context: Record<string, unknown> = {
    document,
    Date,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? 'GET', ...(init.body ? { body: init.body } : {}) });
      const answer = { '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }), ...routes }[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, context);
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const scripts = () => els.accueil!.all().filter((e) => e.tagName === 'script');
  const load = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/alertes.js']);
    runInNewContext(ALERTES_SCRIPT, context);
    s[0]!.listeners.load!({});
    await tick();
  };
  const named = (text: string): FakeElement[] => els.reprendre!.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  // Le retour sur l'accueil relit la journée.
  const reload = () => els.retour!.listeners.click!({});
  return { els, calls, context, tick, scripts, load, named, reload };
}

describe('C09c · alertes dans l’application', () => {
  it('[R12] l’agent voit ses alertes à l’ouverture, avec le motif, le canal et la fiche à ouvrir ; un texte reçu reste du texte', async () => {
    const t = await run({ '/v1/alertes-agent': ok({ alerts: ALERTS, more: false }) });
    expect(t.els['reprendre-etat']!.textContent).toBe('Chargement…');
    await t.load();
    const text = t.els.reprendre!.textContent;
    expect(text).toContain('Léa');
    expect(text).toContain('Aucune réponse n’a pu partir');
    expect(text).toContain('Mail');
    expect(text).toContain('la conversation est à vous');
    expect(t.els.reprendre!.all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).toContain(INJECTED);
    expect(t.els['reprendre-etat']!.textContent).toBe('');
    expect(t.named('Voir la fiche')).toHaveLength(2);
    // Le dire avant tout geste, seulement pour la fiche fermée [R02, R04].
    expect(text.match(/Contact fermé/g)).toHaveLength(1);
  });

  it('sans alerte, rien à charger : le poids n’arrive que quand il sert', async () => {
    const t = await run({ '/v1/alertes-agent': ok({ alerts: [], more: false }) });
    expect(t.els['reprendre-etat']!.textContent).toBe('Rien à reprendre.');
    expect(t.scripts()).toEqual([]);
  });

  it('[R17] marquer vue envoie un seul geste et retire la ligne ; la dernière dit qu’il n’y a plus rien', async () => {
    const answer = ok({ already: false });
    const t = await run({ '/v1/alertes-agent': ok({ alerts: [ALERTS[0]], more: false }), '/v1/alertes-agent/al-1/vue': () => answer() });
    await t.load();
    const b = t.named('Marquer vue')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await t.tick();
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/v1/alertes-agent/al-1/vue', method: 'POST', body: JSON.stringify({ createdAt: ALERTS[0]!.createdAt }) }]);
    expect(t.named('Marquer vue')).toEqual([]);
    expect(t.els['reprendre-etat']!.textContent).toBe('Rien à reprendre.');
  });

  it('sans réseau, l’alerte reste et le bouton revient', async () => {
    const t = await run({ '/v1/alertes-agent': ok({ alerts: [ALERTS[0]], more: false }) });
    await t.load();
    const b = t.named('Marquer vue')[0]!;
    b.listeners.click!({});
    await t.tick();
    expect(t.named('Marquer vue')).toHaveLength(1);
    expect((b as unknown as { disabled: boolean }).disabled).toBe(false);
    expect(t.els['reprendre-etat']!.textContent).toContain('Pas de réseau');
  });

  it('[R12] une alerte rouverte depuis la lecture : la liste est relue, l’alerte reste', async () => {
    let reads = 0;
    const t = await run({
      '/v1/alertes-agent': async () => {
        reads += 1;
        return Response.json({ ok: true, data: { alerts: [ALERTS[0]], more: false } });
      },
      '/v1/alertes-agent/al-1/vue': ok({ already: false, changed: true }),
    });
    await t.load();
    t.named('Marquer vue')[0]!.listeners.click!({});
    await t.tick();
    expect(reads).toBe(2);
    expect(t.named('Marquer vue')).toHaveLength(1);
  });

  it('[R12] avec d’autres alertes en attente, le message reste au retour sur l’accueil et la dernière vue relit la liste', async () => {
    let reads = 0;
    const t = await run({
      '/v1/alertes-agent': async () => {
        reads += 1;
        return Response.json({ ok: true, data: { alerts: reads <= 2 ? [ALERTS[0]] : [ALERTS[1]], more: reads <= 2 } });
      },
      '/v1/alertes-agent/al-1/vue': ok({ already: false, changed: false }),
    });
    await t.load();
    const MORE = 'D’autres alertes apparaîtront quand celles-ci seront vues.';
    expect(t.els['reprendre-etat']!.textContent).toBe(MORE);
    // Script déjà chargé : le texte vient du dessin, il n'est pas écrasé.
    t.reload();
    await t.tick();
    expect(t.els['reprendre-etat']!.textContent).toBe(MORE);
    t.named('Marquer vue')[0]!.listeners.click!({});
    await t.tick();
    expect(reads).toBe(3);
    expect(t.els.reprendre!.textContent).toContain('la conversation est à vous');
    expect(t.els['reprendre-etat']!.textContent).toBe('');
  });

  it('[R16] un refus du serveur relit la liste : la fiche a pu changer de main', async () => {
    let reads = 0;
    const t = await run({
      '/v1/alertes-agent': async () => {
        reads += 1;
        return Response.json({ ok: true, data: { alerts: reads === 1 ? [ALERTS[0]] : [], more: false } });
      },
      '/v1/alertes-agent/al-1/vue': async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }),
    });
    await t.load();
    t.named('Marquer vue')[0]!.listeners.click!({});
    await t.tick();
    expect(reads).toBe(2);
    expect(t.named('Marquer vue')).toEqual([]);
    expect(t.els['reprendre-etat']!.textContent).toBe('Rien à reprendre.');
  });

  it('[R12] [R13] la direction lit sur l’écran du réseau le nombre d’alertes sans agent, et rien de plus', async () => {
    const asDirection = { '/v1/moi': async () => Response.json({ ok: true, data: { role: 'direction', firstName: 'Dana' } }) };
    const some = await run({ ...asDirection, '/v1/alertes-agent/sans-agent': ok({ total: 4, exchanges: 1, needsReply: 3, more: false }) });
    expect(some.els['reseau-sans-agent']!.textContent).toBe('Conversations à reprendre sans agent : 4. Attribuez leurs fiches.');
    // Le script de l'agent n'est pas appelé pour la direction.
    expect(some.calls.some((c) => c.url === '/v1/alertes-agent')).toBe(false);
    const bounded = await run({ ...asDirection, '/v1/alertes-agent/sans-agent': ok({ total: 100, exchanges: 0, needsReply: 100, more: true }) });
    expect(bounded.els['reseau-sans-agent']!.textContent).toContain('au moins 100');
    // Un compte incomplet ne s'affiche jamais comme du vide.
    const unknown = await run({ ...asDirection, '/v1/alertes-agent/sans-agent': ok({ total: 0, exchanges: 0, needsReply: 0, more: true }) });
    expect(unknown.els['reseau-sans-agent']!.textContent).toContain('au moins 0');
    const none = await run({ ...asDirection, '/v1/alertes-agent/sans-agent': ok({ total: 0, exchanges: 0, needsReply: 0, more: false }) });
    expect(none.els['reseau-sans-agent']!.textContent).toBe('');
  });

  it('[R201] le dépôt de la reprise, sorti de l’application pour tenir son budget, se charge au premier geste et marche', async () => {
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('/v1/reprise');
    expect(AGENT_APP_SHELL).not.toContain('/app/reprise.js');
    expect(await handleAgentApp(new Request('https://aimmo.example.test/app/reprise.js'))!.text()).toBe(REPRISE_SCRIPT);
    const t = await run({
      '/v1/alertes-agent': ok({ alerts: [], more: false }),
      '/v1/reprise/etat': ok({ depots: { exclusion_list: { lines: 12, depositedAt: '2026-12-08T09:00:00.000Z' } }, progress: null }),
    });
    t.els['reprise-voir']!.listeners.click!({});
    expect(t.els['reprise-etat']!.textContent).toBe('Chargement…');
    // Un second geste pendant le chargement ne fait rien : aucun dépôt ne part deux fois.
    t.els['reprise-voir']!.listeners.click!({});
    const s = t.els.reseau!.all().filter((e) => e.tagName === 'script');
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/reprise.js']);
    runInNewContext(REPRISE_SCRIPT, t.context);
    s[0]!.listeners.load!({});
    await t.tick();
    expect(t.els['reprise-liste']!.textContent).toContain('12 lignes');
    expect(t.els['reprise-etat']!.textContent).toContain('Il manque 2 fichiers');
    // Déjà chargé : pas de second script.
    t.els['reprise-voir']!.listeners.click!({});
    await t.tick();
    expect(t.els.reseau!.all().filter((e) => e.tagName === 'script')).toHaveLength(1);
  });

  it('[R13] un vrai dépôt de la reprise part une fois, sans rien montrer du fichier ; une session finie arrête la suite', async () => {
    const t = await run({ '/v1/alertes-agent': ok({ alerts: [], more: false }), '/v1/reprise/fichiers': ok({ lines: 3, unreadableLines: 0 }) });
    const sent = () => t.calls.filter((c) => c.url === '/v1/reprise/fichiers');
    const inputs = t.els as unknown as Record<string, { files?: unknown[]; value: string }>;
    inputs['reprise-exclusion_list']!.files = [{ size: 12, text: async () => 'mail\nlea@example.test' }];
    t.els['reprise-deposer']!.listeners.click!({});
    const s = t.els.reseau!.all().filter((e) => e.tagName === 'script');
    runInNewContext(REPRISE_SCRIPT, t.context);
    s[0]!.listeners.load!({});
    await t.tick();
    expect(sent()).toHaveLength(1);
    expect(JSON.parse(sent()[0]!.body!)).toMatchObject({ tool: 'exclusion_list' });
    expect(t.els['reprise-etat']!.textContent).toBe('Dépôt fait.');
    expect(t.els['reprise-liste']!.textContent).not.toContain('example.test');
    inputs['reprise-exclusion_list']!.files = [{ size: 12, text: async () => 'mail\nlea@example.test' }];
    t.els['reprise-deposer']!.listeners.click!({});
    t.els.sortir!.listeners.click!({});
    await t.tick();
    expect(sent()).toHaveLength(1);
  });

  it('[R201] le script est servi à part, hors de la coquille, et tient le budget d’une page', async () => {
    expect(AGENT_APP_SHELL).not.toContain('/app/alertes.js');
    expect(budgetProblems({ html: '', js: ALERTES_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/alertes.js'))!;
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(ALERTES_SCRIPT);
  });
});

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { COFFRE_JS, COFFRE_SCRIPT, CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { GEL_REGISTRE_SCRIPT } from '../app/gel-registre.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : fiches, fuites, noms des signataires, clés de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = (init: { body?: unknown; headers?: Record<string, string> }) => Promise<Response>;
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...extra });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const SHEET = {
  sheetId: 'rs1',
  personId: 'personne-test-a1b2c3',
  relation: 'offre',
  caseRef: 'offer:o1',
  gridVersion: 'essai-1',
  gridDatedOn: '2026-10-28',
  trialGrid: true,
  criteria: [{ key: 'politicallyExposed', label: 'Personne politiquement exposée', source: 'declare', observed: `non ${INJECTED}`, level: 'faible' }],
  computedLevel: 'moyen',
  fingerprint: 'f'.repeat(64),
  preparedBy: 'agent:a1',
  preparedAt: '2026-10-28T09:00:00.000Z',
  validation: null,
  status: 'non_validee',
  notice: 'Fiche de risque non validée.',
};
const BREACH = {
  id: 'b1',
  awareAt: '2026-10-29T06:00:00.000Z',
  deadlineAt: '2099-01-01T06:00:00.000Z',
  evaluation: null,
  due: { cnil: true, personnes: false },
  notified: { cnil: null, personnes: null },
  cuts: [{ id: 'cut1', scope: 'tous', userId: null, keysRevoked: 2, cutAt: '2026-10-29T06:05:00.000Z', restoredAt: null }],
};
const COMPLIANCE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'compliance', firstName: null }),
  'GET /v1/conformite/risque': ok([SHEET]),
  'GET /v1/conformite/vigilance': ok([{ alertId: 'va1', key: 'paiement_comptant', rule: 'R93', label: 'Paiement comptant', figures: {}, text: 'Paiement comptant déclaré.', caseRef: 'offer:o1', personId: 'personne-test-d4e5f6', settingsVersion: 'v1', fingerprint: 'x', raisedAt: '2026-10-28T10:00:00.000Z', decision: null, notice: '' }]),
  'GET /v1/commerces/vigilance': ok([]),
  'GET /v1/conformite/signalements': ok([]),
  'GET /v1/conformite/demandes': ok([{ id: 'd1', personId: 'personne-test-g7h8i9', kind: 'acces', channel: 'mail', receivedOn: '2026-10-20', dueOn: '2026-11-20', noticeOn: '2026-11-13', exclusionId: null, answeredOn: null, answerSha256: null, late: null }]),
  'GET /v1/conformite/demandes/alertes': ok([]),
  'GET /v1/conformite/prospects': ok([]),
  'GET /v1/conformite/fuites': ok([BREACH]),
  'GET /v1/conformite/fuites/alertes': ok([{ breachId: 'b1', kind: 'connaissance', deadlineAt: BREACH.deadlineAt, createdAt: '2026-10-29T06:00:00.000Z', text: `Fuite déclarée ${INJECTED}` }]),
  'GET /v1/conformite/registre': ok({ lastReviewOn: '2026-10-28', initial: true, dueOn: '2027-01-28', noticeOn: '2027-01-13', registryHash: 'r'.repeat(64), changedSinceReview: false }),
  'GET /v1/conformite/registre/alertes': ok([]),
};
const AGENT: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [{ personId: 'p1', firstName: 'Léa', reason: 'Rappel', dueAt: '2026-10-29T09:00:00.000Z', overdue: false }] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/fiches/p1/resume': ok({ firstName: 'Léa', lastName: 'Exemple', contact: { allowed: true, reasons: [] }, call: null, callbacks: [], projects: [], sources: [], consents: [], messages: [] }),
  'GET /v1/conformite/personnes/p1/coffre/recus': ok([{ pieceId: 'v1', kind: 'passeport', label: 'Passeport', sha256: 'a'.repeat(64), depositedAt: '2026-10-28T08:00:00.000Z' }]),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: unknown; type?: string | undefined; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...answers };
  const saved: { name: string; text: Promise<string> }[] = [];
  let lastBlob: Blob | null = null;
  const context: Record<string, unknown> = {
    Blob,
    URL: { createObjectURL: (b: Blob) => ((lastBlob = b), 'blob:essai'), revokeObjectURL: () => undefined },
    setTimeout,
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      const bare = url.split('?')[0]!;
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), type: init.headers?.['content-type'], auth: init.headers?.authorization });
      const a = table[`${method} ${url}`] ?? table[`${method} ${bare}`];
      return a ? a(init) : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  // Le script chargé à la demande : celui que le navigateur ferait tourner, dans la même page.
  const scripts = () => els.conformite!.children.filter((e) => e.tagName === 'script');
  const loadScript = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/conformite.js']);
    runInNewContext(CONFORMITE_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const body = () => els['conformite-corps']!;
  const byText = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  // Le lien de téléchargement posé puis cliqué par le script : son nom et le contenu du fichier.
  const watchSaves = () => {
    const parent = els.conformite!;
    const append = parent.appendChild.bind(parent);
    parent.appendChild = (child: FakeElement) => {
      if (child.tagName === 'a') child.click = () => saved.push({ name: String((child as unknown as { download: string }).download), text: lastBlob!.text() });
      return append(child);
    };
  };
  return { els, calls, table, context, storage, scripts, loadScript, body, byText, click, saved, watchSaves };
}

describe('L10 · écran « Conformité » de l’application', () => {
  it('[R16] la clé du responsable ouvre son écran ; l’agent et la direction ne le reçoivent jamais', async () => {
    const t = await run(COMPLIANCE);
    expect(t.els.conformite!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    await t.loadScript();
    expect(t.els['conformite-etat']!.textContent).toBe('');
    expect(t.body().textContent).toContain('Fiches de risque à valider');
    // Le code de l'écran du responsable n'est pas dans le script de l'application que reçoit chaque agent.
    expect(JS).not.toContain('Fiches de risque à valider');
    expect(JS).not.toContain('/v1/conformite/risque');
    expect(AGENT_APP_SHELL).not.toContain('/app/conformite.js');
    for (const role of ['agent', 'direction']) {
      const other = await run({ ...AGENT, 'GET /v1/moi': ok({ role, firstName: 'Alex' }), 'GET /v1/pilotage/reseau?periode=mois': no(503, {}) });
      expect([role, other.els.conformite!.hidden, other.scripts().length]).toEqual([role, true, 0]);
      expect(other.calls.some((c) => /^\/v1\/conformite\/(?!personnes\/[^/]+\/coffre\/recus$)/.test(c.url))).toBe(false);
    }
  });

  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/conformite, la clé dans l’en-tête seul', async () => {
    const t = await run(COMPLIANCE);
    await t.loadScript();
    t.table['POST /v1/conformite/risque/rs1/valider'] = ok(null);
    t.table['POST /v1/conformite/fuites/b1/couper'] = ok(null);
    await t.click(t.byText(t.body(), 'Valider la fiche'));
    await t.click(t.byText(t.body(), 'Couper tous les accès maintenant'));
    const screen = t.calls.filter((c) => c.url !== '/v1/moi');
    expect(screen.length).toBeGreaterThan(20);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/conformite/') || c.url === '/v1/commerces/vigilance', c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...CONFORMITE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(10);
    for (const r of routes) expect(r.startsWith('/v1/conformite/') || r === '/v1/commerces/vigilance' || r === '/v1/commerces/vigilance/', r).toBe(true);
    expect(CONFORMITE_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write|\.sort\(/);
  });

  it('[R91] la fiche à valider : niveau proposé par la grille, décision signée, refus dit sans code ; tout texte reste du texte', async () => {
    const t = await run(COMPLIANCE);
    await t.loadScript();
    const text = t.body().textContent;
    expect(text).toContain('Client …a1b2c3 · Offre, préparée le 28/10/2026');
    expect(text).toContain(`Personne politiquement exposée : non ${INJECTED} (faible)`);
    expect(text).toContain('Niveau proposé par la grille : moyen');
    expect(text).toContain(`Fuite déclarée ${INJECTED}`);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    // Aucune donnée personnelle : ni nom, ni identifiant entier de fiche.
    expect(text).not.toContain('personne-test-a1b2c3');
    const summary = t.els['conformite-resume']!.children.map((li) => li.textContent);
    expect(summary).toEqual(['1fiche à valider', '1alerte de vigilance', '0alertes de cession', '0signalements à décider', '1demande en cours', '1fuite à notifier']);

    const form = t.body().all().find((e) => e.className === 'decision')!;
    const [level, reason, name] = form.all().filter((e) => e.tagName === 'select' || e.tagName === 'textarea' || e.tagName === 'input');
    expect(level!.value).toBe('moyen');
    level!.value = 'eleve';
    name!.value = ' Responsable Test ';
    t.table['POST /v1/conformite/risque/rs1/valider'] = no(400, { ok: false, rule: null, code: 'missing_reason' });
    await t.click(t.byText(form, 'Valider la fiche'));
    const post = t.calls.filter((c) => c.method === 'POST');
    expect(post.map((c) => [c.url, JSON.parse(String(c.body))])).toEqual([['/v1/conformite/risque/rs1/valider', { validatorName: 'Responsable Test', level: 'eleve' }]]);
    expect(form.textContent).toContain('Écrivez la raison de la décision.');
    reason!.value = 'Paiement en partie comptant.';
    t.table['POST /v1/conformite/risque/rs1/valider'] = ok(null);
    t.table['GET /v1/conformite/risque'] = ok([]);
    await t.click(t.byText(form, 'Valider la fiche'));
    expect(JSON.parse(String(t.calls.filter((c) => c.method === 'POST')[1]!.body))).toEqual({ validatorName: 'Responsable Test', level: 'eleve', reason: 'Paiement en partie comptant.' });
    expect(t.els['conformite-etat']!.textContent).toBe('Fiche validée.');
    expect(t.body().textContent).toContain('Aucune fiche n’attend votre validation.');
  });

  it('[R97] la fuite : échéance de la CNIL dite, coupure de tous les accès, rétablissement, déclaration', async () => {
    const t = await run(COMPLIANCE);
    await t.loadScript();
    const text = t.body().textContent;
    expect(text).toContain('CNIL à prévenir avant le 01/01/2099');
    expect(t.body().all().some((e) => e.className === 'compte urgent')).toBe(true);
    for (const [label, path] of [
      ['Couper tous les accès maintenant', '/v1/conformite/fuites/b1/couper'],
      ['Rétablir cet accès', '/v1/conformite/fuites/b1/retablir'],
      ['Déclarer une fuite connue maintenant', '/v1/conformite/fuites'],
    ] as const) {
      t.table[`POST ${path}`] = ok(null);
      await t.click(t.byText(t.body(), label));
    }
    const posts = t.calls.filter((c) => c.method === 'POST').map((c) => [c.url, JSON.parse(String(c.body))]);
    expect(posts[0]).toEqual(['/v1/conformite/fuites/b1/couper', { scope: 'tous' }]);
    expect(posts[1]).toEqual(['/v1/conformite/fuites/b1/retablir', { cutId: 'cut1' }]);
    expect(posts[2]![0]).toBe('/v1/conformite/fuites');
    expect(Number.isNaN(Date.parse(posts[2]![1].awareAt))).toBe(false);
  });

  it('[R96] une demande d’accès : réponse assemblée par le code, puis réponse notée ; une demande reçue s’enregistre', async () => {
    const t = await run(COMPLIANCE);
    await t.loadScript();
    t.watchSaves();
    const response = { persons: [{ table: 'persons', rows: [{ first_name: 'Prénom inventé' }] }] };
    t.table['GET /v1/conformite/demandes/d1/acces'] = ok({ response, sha256: 'e'.repeat(64) });
    const answer = () => t.byText(t.body(), 'Noter la réponse envoyée aujourd’hui')!;
    // Pas de réponse notée avant que la réponse complète ne soit enregistrée.
    expect(answer().hidden).toBe(true);
    await t.click(t.byText(t.body(), 'Assembler la réponse d’accès'));
    expect(t.body().textContent).toContain(`Réponse assemblée depuis chaque table du registre. Empreinte : ${'e'.repeat(64)}`);
    expect(answer().hidden).toBe(true);
    await t.click(t.byText(t.body(), 'Enregistrer la réponse complète'));
    expect(t.saved.map((s) => s.name)).toEqual(['reponse-acces-d1.json']);
    expect(JSON.parse(await t.saved[0]!.text)).toEqual({ demande: 'd1', sorte: 'acces', empreinte: 'e'.repeat(64), contenu: response });
    expect(answer().hidden).toBe(false);
    expect(t.calls.some((c) => c.url.endsWith('/repondre'))).toBe(false);
    t.table['POST /v1/conformite/demandes'] = no(400, { ok: false, rule: null, code: 'unknown_person' });
    await t.click(t.byText(t.body(), 'Enregistrer la demande'));
    const post = t.calls.find((c) => c.method === 'POST' && c.url === '/v1/conformite/demandes')!;
    expect(Object.keys(JSON.parse(String(post.body)))).toEqual(['personId', 'kind', 'channel', 'receivedOn']);
    expect(t.body().textContent).toContain('Aucune fiche ne porte cet identifiant.');
  });

  it('accessible : chaque champ a son libellé, chaque groupe de cases sa légende, chaque état est annoncé', async () => {
    const t = await run(COMPLIANCE);
    await t.loadScript();
    const all = t.body().all();
    const labels = new Set(all.filter((e) => e.tagName === 'label').map((l) => l.attributes.for));
    const fields = all.filter((e) => ['input', 'select', 'textarea'].includes(e.tagName));
    expect(fields.length).toBeGreaterThan(15);
    for (const f of fields) expect(labels.has(f.attributes.id), f.attributes.id).toBe(true);
    expect(new Set(fields.map((f) => f.attributes.id)).size).toBe(fields.length);
    const groups = all.filter((e) => e.tagName === 'fieldset');
    expect(groups.length).toBe(2);
    for (const g of groups) expect(g.children[0]!.tagName).toBe('legend');
    for (const s of all.filter((e) => e.className === 'etat' && e.tagName === 'p' && e.textContent === '')) expect(s.attributes.role).toBe('status');
    // Les titres : h2 pour l'écran, h3 pour chaque bloc, h4 dans un bloc, sans saut.
    expect(HTML).toMatch(/<h2 id="conformite-titre">Conformité<\/h2>/);
    expect(all.filter((e) => /^h[1-6]$/.test(e.tagName)).every((h) => h.tagName === 'h3' || h.tagName === 'h4')).toBe(true);
    expect(HTML).toMatch(/<p id="conformite-etat" class="etat" role="status">/);
  });

  it('[R16] une clé refusée pendant l’écran du responsable efface la clé, l’écran, et revient à la connexion', async () => {
    for (const refusal of [no(401, { ok: false }), no(403, { ok: false, rule: 'R16', code: 'agent_inactive' })]) {
      const t = await run(COMPLIANCE);
      await t.loadScript();
      t.table['POST /v1/conformite/risque/rs1/valider'] = refusal;
      await t.click(t.byText(t.body(), 'Valider la fiche'));
      expect(t.storage.has('aimmo.cle')).toBe(false);
      expect(t.els.connexion!.hidden).toBe(false);
      expect(t.els.conformite!.hidden).toBe(true);
      expect(t.body().children).toEqual([]);
      expect(t.els['conformite-resume']!.children).toEqual([]);
    }
    const read = await run({ ...COMPLIANCE, 'GET /v1/conformite/fuites': no(401, { ok: false }) });
    await read.loadScript();
    expect([read.storage.has('aimmo.cle'), read.els.connexion!.hidden, read.body().children.length]).toEqual([false, false, 0]);
  });

  it('une réponse d’une session finie ne touche plus l’écran : sortie pendant le chargement du script ou des lectures', async () => {
    const t = await run(COMPLIANCE);
    await t.click(t.els.sortir);
    await t.loadScript();
    expect(t.calls.filter((c) => c.url.startsWith('/v1/conformite/'))).toEqual([]);
    expect(t.els.conformite!.hidden).toBe(true);
    expect(t.els.connexion!.hidden).toBe(false);
    // Lectures lentes : la sortie arrive avant leurs réponses, qui ne montrent plus rien.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: Record<string, Answer> = Object.fromEntries(Object.entries(COMPLIANCE).map(([k, a]) => [k, k === 'GET /v1/moi' ? a : async (i) => { await gate; return a(i); }]));
    const s = await run(slow);
    await s.loadScript();
    await s.click(s.els.sortir);
    release();
    await settle();
    expect(s.body().children).toEqual([]);
    expect(s.els['conformite-resume']!.children).toEqual([]);
    expect(s.els.connexion!.hidden).toBe(false);
  });

  it('une lecture qui échoue ne compte jamais pour zéro dans le résumé', async () => {
    const t = await run({ ...COMPLIANCE, 'GET /v1/conformite/signalements': no(500, { ok: false }) });
    await t.loadScript();
    const summary = t.els['conformite-resume']!.children.map((li) => li.textContent);
    expect(summary).toContain('?signalements à décider : non lu');
    expect(summary.some((s) => s.startsWith('0signalement'))).toBe(false);
    expect(t.els['conformite-etat']!.textContent).toBe('Une partie de l’écran n’a pas pu être lue : actualisez dans un moment.');
  });

  it('un écran qui ne répond pas le dit, sans rien montrer ; le script qui ne se charge pas aussi', async () => {
    const down = await run({ 'GET /v1/moi': ok({ role: 'compliance', firstName: null }) });
    await down.loadScript();
    expect(down.els['conformite-etat']!.textContent).toBe('Indisponible pour le moment. Réessayez plus tard.');
    expect(down.body().children).toEqual([]);
    const offline = await run(COMPLIANCE);
    offline.scripts()[0]!.listeners.error!({});
    await settle();
    expect(offline.els['conformite-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
  });
});

describe('CE21 · le responsable lit et décide les alertes de cession', () => {
  const ALERT = { id: 'ca1', fileId: 'f1', personId: 'personne-test-z9y8x7', missing: ['beneficiaires_effectifs', 'origine_des_fonds'], raisedAt: '2026-10-28T08:00:00.000Z', decision: null };
  const POST = 'POST /v1/commerces/vigilance/ca1/decision';
  const SIGN = 'Signer la décision';
  async function open(more: Record<string, Answer> = {}) {
    const t = await run({ ...COMPLIANCE, 'GET /v1/conformite/vigilance': ok([]), 'GET /v1/commerces/vigilance': ok([ALERT]), ...more });
    await t.loadScript();
    const section = () => t.body().children.find((e) => e.all().some((x) => x.textContent === 'Vigilance des cessions de fonds'))!;
    const fill = () => {
      const fields = section().all();
      fields.find((e) => e.tagName === 'textarea')!.value = 'Raison inventée.';
      fields.find((e) => e.tagName === 'input')!.value = 'Nom Inventé';
    };
    const sign = () => t.click(t.byText(section(), SIGN));
    const posted = () => t.calls.filter((c) => c.method === 'POST' && c.url === '/v1/commerces/vigilance/ca1/decision');
    const said = () => section().all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent).join('');
    return { ...t, section, fill, sign, posted, said };
  }

  it('[R118] [R15] l’alerte se lit : ce qui manque et la fin de la référence, jamais une pièce ni un montant ; le résumé la compte', async () => {
    const t = await open();
    const text = t.section().textContent;
    expect(text).toContain('Cession d’un fonds : à la levée de l’alerte, il manquait au coffre : bénéficiaires effectifs, origine des fonds.');
    expect(text).toContain('Coffre non relu : vérifiez-le avant de décider.');
    expect(text).toContain('Client …z9y8x7');
    expect(text).not.toContain('personne-test');
    expect(t.els['conformite-resume']!.textContent).toContain('alerte de cession');
  });

  const RELU = { checkedAt: '2026-11-16T08:12:00.000Z', buyerCurrent: true };
  const withAlert = (more: Record<string, unknown>) => ({ 'GET /v1/commerces/vigilance': ok([{ ...ALERT, ...more }]) });

  it('[R118] BR96 · relue au coffre : ce qui manque encore, ce qui est déposé depuis, avec la date et l’heure', async () => {
    const t = await open(withAlert({ ...RELU, stillMissing: ['beneficiaires_effectifs'] }));
    const text = t.section().textContent;
    expect(text).toContain('il manquait au coffre : bénéficiaires effectifs, origine des fonds.');
    expect(text).toContain('Relu au coffre le 16/11/2026 à 09:12 : il manque encore bénéficiaires effectifs.');
    expect(text).toContain('Déposé depuis la levée : origine des fonds.');
    expect(text).not.toContain('Coffre non relu');
    expect(text).not.toContain('remplacé');
  });

  it('[R118] BR96 · rien déposé depuis : tout manque encore, rien n’est dit déposé', async () => {
    const t = await open(withAlert({ ...RELU, stillMissing: ['beneficiaires_effectifs', 'origine_des_fonds'] }));
    const text = t.section().textContent;
    expect(text).toContain('il manque encore bénéficiaires effectifs, origine des fonds.');
    expect(text).not.toContain('Déposé depuis');
  });

  it('[R14] BR96 · tout déposé depuis : dit, mais la décision reste au responsable', async () => {
    const t = await open(withAlert({ ...RELU, stillMissing: [] }));
    expect(t.section().textContent).toContain('Relu au coffre le 16/11/2026 à 09:12 : tout ce qui manquait est déposé depuis. La décision reste la vôtre.');
    expect(t.byText(t.section(), SIGN)).toBeDefined();
    expect(t.els['conformite-resume']!.textContent).toContain('1alerte de cession');
  });

  it.each([
    ['nul', { ...RELU, stillMissing: null }],
    ['absent', {}],
    ['sans heure de relecture', { stillMissing: [] }],
    ['heure illisible', { stillMissing: [], checkedAt: 'pas une date' }],
  ])('[R10] BR96 · coffre non relu (%s) : jamais « tout est déposé »', async (_n, more) => {
    const t = await open(withAlert(more));
    const text = t.section().textContent;
    expect(text).toContain('Coffre non relu : vérifiez-le avant de décider.');
    expect(text).not.toContain('déposé depuis');
    expect(text).not.toContain('Relu au coffre');
  });

  it('BR96 · un acquéreur remplacé depuis se dit sur l’ancienne alerte', async () => {
    const t = await open(withAlert({ ...RELU, stillMissing: [], buyerCurrent: false }));
    expect(t.section().textContent).toContain('L’acquéreur de cette alerte a été remplacé depuis sur le dossier.');
  });

  it('[R15] [R13] BR96 · aucune pièce ni montant, la référence reste tronquée', async () => {
    const t = await open(withAlert({ ...RELU, stillMissing: ['origine_des_fonds'] }));
    const text = t.section().textContent;
    expect(text).not.toContain('personne-test');
    expect(text).not.toMatch(/€|\d+,\d{2}/);
    expect(text).toContain('Client …z9y8x7');
  });

  it('[R10] une lecture manquée n’est jamais « aucune alerte »', async () => {
    const t = await open({ 'GET /v1/commerces/vigilance': no(500, {}) });
    expect(t.els['conformite-resume']!.textContent).toContain('alertes de cession : non lu');
    expect(t.body().textContent).not.toContain('Vigilance des cessions de fonds');
  });

  it('[R14] [R118] le responsable décide, avec sa raison et son nom, et la décision se relit', async () => {
    const t = await open({ [POST]: ok({ ...ALERT }) });
    t.fill();
    t.table['GET /v1/commerces/vigilance'] = ok([{ ...ALERT, decision: { decision: 'origine_des_fonds_demandee', reason: 'Raison inventée.', validatorName: 'Nom Inventé', decidedAt: '2026-10-29T08:00:00.000Z' } }]);
    await t.sign();
    expect(t.posted()).toHaveLength(1);
    expect(JSON.parse(t.posted()[0]!.body as string)).toMatchObject({ reason: 'Raison inventée.', validatorName: 'Nom Inventé' });
    expect(t.els['conformite-etat']!.textContent).toBe('Décision rangée.');
    expect(t.section().textContent).toContain('Nom Inventé, le 29/10/2026');
    expect(t.byText(t.section(), SIGN)).toBeUndefined();
  });

  it('[R14] sans raison ni nom, rien ne part', async () => {
    const t = await open();
    await t.sign();
    expect(t.posted()).toHaveLength(0);
    expect(t.said()).toBe('La raison et votre nom sont à remplir.');
  });

  it.each([
    ['panne', (async () => new Response('non', { status: 502 })) as Answer, 'Réponse perdue : la décision est peut-être rangée. Actualisez avant de recommencer.'],
    ['droits', no(403, { ok: false, rule: 'R16', code: 'role' }), 'Cet écran est réservé au responsable de la conformité.'],
    ['nom', no(400, { ok: false, rule: null, code: 'missing_name' }), 'Écrivez votre nom : il signe la décision.'],
  ])('[R10] chaque réponse est dite, la saisie reste (%s)', async (_n, answer, said) => {
    const t = await open({ [POST]: answer });
    t.fill();
    await t.sign();
    expect(t.said()).toBe(said);
    expect(t.section().all().find((e) => e.tagName === 'textarea')!.value).toBe('Raison inventée.');
  });

  it('[R17] une alerte déjà décidée ailleurs : la décision rangée est relue, rien n’est dit refusé', async () => {
    const t = await open({ [POST]: no(400, { ok: false, rule: null, code: 'already_decided' }) });
    t.fill();
    await t.sign();
    expect(t.els['conformite-etat']!.textContent).toBe('Cette alerte était déjà décidée : voici la décision rangée.');
  });

  it('[R10] un seul envoi à la fois', async () => {
    let free: () => void = () => {};
    const t = await open({ [POST]: () => new Promise((r) => { free = () => r(Response.json({ ok: true, data: {} })); }) });
    t.fill();
    const go = t.byText(t.section(), SIGN)!;
    go.listeners.click!({});
    go.listeners.click!({});
    expect(t.posted()).toHaveLength(1);
    free();
    await settle();
  });

  it('[R201] le script tient le budget d’une page', () => {
    expect(budgetProblems({ html: '', js: CONFORMITE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});

describe('L10 · dépôt d’une pièce au coffre depuis la fiche', () => {
  // BR102 : le bloc se charge au geste « Pièces au coffre », par le chargeur commun ; le script servi tourne dans la page.
  const coffreScripts = (t: Awaited<ReturnType<typeof run>>) => t.els.fiche!.children.filter((e) => e.attributes.src === '/app/coffre.js');
  const openFiche = async () => {
    const t = await run(AGENT);
    await t.click(t.byText(t.els.chauds!, 'Voir la fiche'));
    await t.click(t.byText(t.els['fiche-corps']!, 'Pièces au coffre'));
    runInNewContext(COFFRE_SCRIPT, t.context);
    coffreScripts(t)[0]!.listeners.load!({});
    await settle();
    const box = t.els['fiche-corps']!.all().find((e) => e.className === 'coffre')!;
    return { ...t, box };
  };

  it('[R201] BR102 · servi à part, chargé au geste : rien n’est lu au coffre avant, et l’application y gagne sa place', async () => {
    const t = await run(AGENT);
    await t.click(t.byText(t.els.chauds!, 'Voir la fiche'));
    expect(t.calls.some((c) => c.url.includes('/coffre'))).toBe(false);
    expect(coffreScripts(t)).toEqual([]);
    expect(AGENT_APP_FILES['/app/coffre.js']).toBe(COFFRE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/coffre.js');
    // DS010 · la fiche servie à part demande ce bloc au chargeur commun.
    expect(AGENT_APP_FILES['/app/fiche.js']).toContain("lazyBlock('Pièces au coffre', '/app/coffre.js', 'AIMMO_COFFRE', personId)");
    // Le dépôt n'est plus dans le script que reçoit chaque agent : ni la liste des preuves, ni le formulaire.
    for (const gone of ['/coffre/recus', 'Déposer au coffre', 'Sorte de pièce', 'vault_not_configured']) expect(JS).not.toContain(gone);
    expect(COFFRE_SCRIPT).not.toContain('innerHTML');
    expect(budgetProblems({ html: '', js: COFFRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    // La place gagnée était réservée à la dictée en sortant d'une visite (BR103), fusionnée depuis : le budget ci-dessus suffit.
    // Le geste charge le script une fois, puis les preuves de la fiche seulement.
    await t.click(t.byText(t.els['fiche-corps']!, 'Pièces au coffre'));
    expect(coffreScripts(t)).toHaveLength(1);
    runInNewContext(COFFRE_SCRIPT, t.context);
    coffreScripts(t)[0]!.listeners.load!({});
    await settle();
    expect(t.calls.filter((c) => c.url.includes('/coffre')).map((c) => c.url)).toEqual(['/v1/conformite/personnes/p1/coffre/recus']);
  });

  it('[R10] BR102 · une preuve mal formée n’est pas dite ; aucune preuve : dit en mots', async () => {
    const t = await run({ ...AGENT, 'GET /v1/conformite/personnes/p1/coffre/recus': ok([{ pieceId: 'v9', label: 7 }, null]) });
    await t.click(t.byText(t.els.chauds!, 'Voir la fiche'));
    await t.click(t.byText(t.els['fiche-corps']!, 'Pièces au coffre'));
    runInNewContext(COFFRE_SCRIPT, t.context);
    coffreScripts(t)[0]!.listeners.load!({});
    await settle();
    const box = t.els['fiche-corps']!.all().find((e) => e.className === 'coffre')!;
    expect(box.all().filter((e) => e.tagName === 'li')).toEqual([]);
    const u = await run({ ...AGENT, 'GET /v1/conformite/personnes/p1/coffre/recus': ok([]) });
    await u.click(u.byText(u.els.chauds!, 'Voir la fiche'));
    await u.click(u.byText(u.els['fiche-corps']!, 'Pièces au coffre'));
    runInNewContext(COFFRE_SCRIPT, u.context);
    coffreScripts(u)[0]!.listeners.load!({});
    await settle();
    expect(u.els['fiche-corps']!.textContent).toContain('Aucune pièce déposée.');
  });

  it('[R90] l’agent dépose la pièce par son corps brut et lit la preuve de dépôt, jamais la pièce', async () => {
    const t = await openFiche();
    expect(t.box.textContent).toContain('Passeport, déposée le 28/10/2026');
    expect(t.box.textContent).toContain(`Empreinte : ${'a'.repeat(64)}`);
    const inputs = t.box.all().filter((e) => e.tagName === 'input' || e.tagName === 'select');
    const [kind, verified, , file] = inputs;
    kind!.value = 'carte_identite';
    verified!.value = '2026-10-28';
    const piece = { type: 'application/pdf', size: 1200 };
    (file as unknown as { files: unknown[] }).files = [piece];
    t.table['POST /v1/conformite/personnes/p1/coffre'] = ok(null, { receipt: { pieceId: 'v2', kind: 'carte_identite', label: 'Carte d’identité', sha256: 'b'.repeat(64), depositedAt: '2026-10-29T08:00:00.000Z' } });
    await t.click(t.byText(t.box, 'Déposer au coffre'));
    const post = t.calls.find((c) => c.method === 'POST')!;
    expect([post.url, post.body, post.type, post.auth]).toEqual(['/v1/conformite/personnes/p1/coffre?sorte=carte_identite&verifie=2026-10-28', piece, 'application/pdf', `Bearer ${KEY}`]);
    expect(t.box.textContent).toContain(`Déposée : Carte d’identité. Empreinte : ${'b'.repeat(64)}`);
    // L'agent ne demande jamais une pièce : seulement la liste de ses preuves de dépôt.
    expect(t.calls.filter((c) => c.url.startsWith('/v1/conformite/')).map((c) => c.url.split('?')[0])).toEqual([
      '/v1/conformite/personnes/p1/coffre/recus',
      '/v1/conformite/personnes/p1/coffre',
      '/v1/conformite/personnes/p1/coffre/recus',
    ]);
    expect(COFFRE_JS).not.toContain('/v1/conformite/coffre/');
    expect(COFFRE_SCRIPT).not.toContain('/v1/conformite/coffre/');
  });

  it('[R90] un fichier d’un autre format est refusé sur place ; un coffre fermé est dit tel quel', async () => {
    const t = await openFiche();
    const file = t.box.all().filter((e) => e.tagName === 'input')[2]!;
    (file as unknown as { files: unknown[] }).files = [{ type: 'image/gif', size: 10 }];
    await t.click(t.byText(t.box, 'Déposer au coffre'));
    expect(t.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(t.box.textContent).toContain('Seuls les PDF, JPEG et PNG entrent au coffre.');
    (file as unknown as { files: unknown[] }).files = [{ type: 'image/png', size: 11 * 1024 * 1024 }];
    await t.click(t.byText(t.box, 'Déposer au coffre'));
    expect(t.box.textContent).toContain('La pièce dépasse 10 Mo.');
    (file as unknown as { files: unknown[] }).files = [{ type: 'image/png', size: 10 }];
    t.table['POST /v1/conformite/personnes/p1/coffre'] = no(503, { ok: false, rule: null, code: 'vault_not_configured' });
    await t.click(t.byText(t.box, 'Déposer au coffre'));
    expect(t.box.textContent).toContain('Le coffre n’est pas encore ouvert : aucune pièce ne peut y être déposée pour le moment.');
    t.table['POST /v1/conformite/personnes/p1/coffre'] = no(403, { ok: false, rule: 'R16', code: 'not_assigned' });
    await t.click(t.byText(t.box, 'Déposer au coffre'));
    expect(t.box.textContent).toContain('Ce client est suivi par un autre agent.');
    expect(t.storage.get('aimmo.cle')).toBe(KEY);
  });

  it('[R16] un dépôt refusé pour clé refusée ou agent qui n’est plus actif efface la clé et la fiche', async () => {
    for (const refusal of [no(401, { ok: false }), no(403, { ok: false, rule: 'R16', code: 'agent_inactive' })]) {
      const t = await openFiche();
      (t.box.all().filter((e) => e.tagName === 'input')[2] as unknown as { files: unknown[] }).files = [{ type: 'image/png', size: 10 }];
      t.table['POST /v1/conformite/personnes/p1/coffre'] = refusal;
      await t.click(t.byText(t.box, 'Déposer au coffre'));
      expect(t.storage.has('aimmo.cle')).toBe(false);
      expect(t.els.connexion!.hidden).toBe(false);
      expect(t.els['fiche-corps']!.children).toEqual([]);
      expect(t.els['fiche-nom']!.textContent).toBe('');
    }
  });
});

describe('BR85 · le registre des gels sur l’écran du responsable', () => {
  it('[R201] l’import se charge au premier geste, une seule fois, et appelle la route du téléchargement', async () => {
    const t = await run(COMPLIANCE);
    await t.loadScript();
    // DS009 : les registres ont leur rubrique.
    const part = t.els['conformite-registres']!.children.find((e) => e.tagName === 'section' && e.textContent.startsWith('Registre des gels'))!;
    expect(part).toBeDefined();
    const before = t.calls.length;
    // Rien n'est chargé ni appelé tant que le responsable n'a pas ouvert l'import.
    expect(part.all().some((e) => e.tagName === 'script')).toBe(false);
    await t.click(t.byText(part, 'Ouvrir l’import du registre'));
    const scripts = part.all().filter((e) => e.tagName === 'script');
    expect(scripts.map((e) => e.attributes.src)).toEqual(['/app/gel-registre.js']);
    runInNewContext(GEL_REGISTRE_SCRIPT, t.context);
    // BR86 : à l'ouverture, le registre en service est lu, et rien d'autre.
    t.table['GET /v1/securite/gel/registre'] = ok(null);
    scripts[0]!.listeners.load!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/securite/gel/registre']);
    t.table['POST /v1/securite/gel/registre/dgtresor'] = ok({ versionId: 'v1', entries: 2, sha256: 'a'.repeat(64), checked: 0, publishedAt: '2027-03-01T09:00:00.000Z', vessels: 0 });
    await t.click(t.byText(part, 'Importer le registre du jour'));
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/securite/gel/registre', 'POST /v1/securite/gel/registre/dgtresor', 'GET /v1/securite/gel/registre']);
    expect(part.textContent).toContain('2 personnes ou sociétés lues, 0 navire laissé à part');
    // Rouvrir ne recharge pas le script.
    await t.click(t.byText(part, 'Ouvrir l’import du registre'));
    expect(part.all().filter((e) => e.tagName === 'script')).toHaveLength(1);
  });
});

describe('L10 · fichiers de l’écran', () => {
  it('[R201] le script du responsable est servi à part, sous la politique de l’application, et tient le budget d’une page', async () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/conformite.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await r.text()).toBe(CONFORMITE_SCRIPT);
    expect(budgetProblems({ html: '', js: CONFORMITE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('aucune donnée personnelle dans les journaux du navigateur : ni console, ni stockage', () => {
    for (const code of [COFFRE_JS, CONFORMITE_SCRIPT]) {
      expect(code).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB/);
    }
  });
});

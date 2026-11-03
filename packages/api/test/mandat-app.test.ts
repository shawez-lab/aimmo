import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MANDAT_SCRIPT } from '../app/mandat.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: unknown };
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string, extra: object = {}): Answer => async () => Response.json({ ok: false, code, ...extra }, { status });
const OWNER = { personId: 'p1', firstName: 'Léa', lastName: 'Exemple' };
const DOC = { id: 'd1', kind: 'mandat_vente_simple', mode: 'reel', status: 'complet', missing: [], createdAt: '2027-02-10T09:00:00.000Z', signature: null };
const READ = { propertyId: 'b1', documents: [] as unknown[], mandate: null as unknown, owners: [OWNER] };
const PASSED = { documentId: 'd1', passed: true, checkedAt: '2027-02-10T09:00:00.000Z', lines: [{ check: 'champs', ok: true, code: 'complete' }, { check: 'honoraires', ok: true, code: 'fee_in_schedule' }] };
const FAILED = { documentId: 'd1', passed: false, checkedAt: '2027-02-10T09:00:00.000Z', lines: [{ check: 'champs', ok: true, code: 'complete' }, { check: 'identite', ok: false, code: 'identity_missing' }] };
const SIGN = 'POST /v1/documents/d1/signature-papier';
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'AV-1', city: 'Dijon', state: null }]),
  'GET /v1/biens/b1/mandat': ok(READ),
  'POST /v1/documents/d1/controle': ok(PASSED),
};
const pdf = (type = 'application/pdf', size = 8) => ({ type, size, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer });

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document: { ...document, body: { appendChild() {}, removeChild() {} } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: unknown } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    crypto: globalThis.crypto,
    setTimeout,
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const find = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const body = () => els['mandat-corps']!;
  const press = (text: string) => click(find(body(), text));
  const state = () => els['mandat-etat']!.textContent;
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { value: string; files?: unknown[] };
  const open = async () => {
    await click(find(els.biens!, 'Mandat'));
    const s = els.mandat!.children.filter((e) => e.tagName === 'script');
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/mandat.js']);
    runInNewContext(MANDAT_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const fillSign = (file: unknown = pdf()) => {
    input('mandat-jour-d1').value = '2027-02-10';
    input('mandat-lieu-d1').value = 'agence';
    input('mandat-source-d1').value = 'referral';
    input('mandat-scan-d1').files = [file];
  };
  return { els, calls, table, body, press, state, input, click, open, fillSign, posts: () => calls.filter((c) => c.method === 'POST') };
}

describe('D12 · écran « Mandat »', () => {
  it('[R201] le script est à part, et l’application reste dans son budget', () => {
    expect(AGENT_APP_FILES['/app/mandat.js']).toBe(MANDAT_SCRIPT);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(budgetProblems({ html: '', js: MANDAT_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R39] l’agent prépare le mandat depuis « Mes biens » : l’écran envoie ce qui est saisi, sans rien calculer', async () => {
    const t = await run({ 'POST /v1/documents': ok({ id: 'd1' }) });
    await t.open();
    expect(t.els.mandat!.hidden).toBe(false);
    expect(t.body().textContent).toContain('Aucun mandat signé pour ce bien.');
    t.input('mandat-type').value = 'mandat_vente_simple';
    t.input('mandat-honoraires').value = '9000';
    t.input('mandat-charge').value = 'vendeur';
    t.input('mandat-duree').value = '12';
    t.table['GET /v1/biens/b1/mandat'] = ok({ ...READ, documents: [DOC] });
    await t.press('Préparer le mandat');
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/documents', body: { kind: 'mandat_vente_simple', personId: 'p1', propertyId: 'b1', inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } } }]);
    expect(t.state()).toContain('Mandat préparé');
    expect(t.body().textContent).toContain('Mandat simple');
  });

  it('[R16] aucun identifiant à saisir : le mandant se choisit, et sans propriétaire lié rien ne se prépare', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, owners: [] }) });
    await t.open();
    expect(t.body().textContent).toContain('Aucun propriétaire n’est lié à ce bien');
    expect(t.body().all().find((e) => e.tagName === 'button' && e.textContent === 'Préparer le mandat')).toBeUndefined();
    const u = await run();
    await u.open();
    expect(u.input('mandat-mandant').tagName).toBe('select');
    expect(u.body().textContent).toContain('Léa Exemple');
    expect(u.body().textContent).not.toContain('p1');
  });

  it('une saisie incomplète et un refus du code sont dits en français, sans rien envoyer de faux', async () => {
    const t = await run({ 'POST /v1/documents': no(409, 'no_template') });
    await t.open();
    await t.press('Préparer le mandat');
    expect(t.state()).toBe('Choisissez le type de mandat.');
    expect(t.posts()).toEqual([]);
    t.input('mandat-type').value = 'mandat_vente_simple';
    t.input('mandat-honoraires').value = '4,5 %';
    await t.press('Préparer le mandat');
    expect(t.state()).toBe('Les honoraires : un montant en euros, sans centimes.');
    t.input('mandat-honoraires').value = '9000';
    t.input('mandat-charge').value = 'vendeur';
    t.input('mandat-duree').value = '12';
    await t.press('Préparer le mandat');
    expect(t.state()).toBe('Aucun modèle de mandat n’est encore enregistré : voyez avec la direction.');
  });

  it('[R41] un seul échec de contrôle et rien ne se signe, la ligne dite en français', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/documents/d1/controle': ok(FAILED) });
    await t.open();
    expect(t.body().all().find((e) => e.textContent === 'Enregistrer la signature')).toBeUndefined();
    await t.press('Contrôler avant signature');
    const text = t.body().textContent;
    expect(text).toContain('Bon : Tous les champs sont remplis.');
    expect(text).toContain('À régler : L’identité du mandant n’est pas vérifiée');
    expect(t.state()).toContain('rien ne se signe');
    expect(t.body().all().find((e) => e.textContent === 'Enregistrer la signature')).toBeUndefined();
  });

  it('[R41] une ligne inconnue n’est jamais dite bonne', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/documents/d1/controle': ok({ ...FAILED, lines: [{ check: 'x', ok: false, code: 'jamais_vu' }] }) });
    await t.open();
    await t.press('Contrôler avant signature');
    expect(t.body().textContent).toContain('À régler : ce contrôle n’est pas passé.');
  });

  it('[R41] chaque code d’identité du contrôle est dit en français, jamais par le texte de repli', async () => {
    const codes = ['identity_missing', 'identity_expired', 'kbis_missing', 'kbis_expired', 'beneficial_owners_missing', 'beneficial_owner_unidentified'];
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/documents/d1/controle': ok({ ...FAILED, lines: codes.map((code) => ({ check: 'identite', ok: false, code })) }) });
    await t.open();
    await t.press('Contrôler avant signature');
    expect(t.body().textContent).not.toContain('ce contrôle n’est pas passé');
    expect(t.body().textContent).toContain('a expiré');
    expect(t.body().textContent).toContain('Kbis');
  });

  it('[R39] un mandat vivant : un autre document préparé ne se contrôle ni ne se signe, et le mandat rétracté rouvre', async () => {
    const live = { id: 'm1', number: 'T-001', signedAt: '2027-02-10T12:00:00.000Z', allowed: true, reason: 'allowed' };
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC], mandate: live }) });
    await t.open();
    expect(t.body().textContent).toContain('Un mandat est déjà en cours sur ce bien');
    expect(t.body().all().find((e) => e.textContent === 'Contrôler avant signature')).toBeUndefined();
    const u = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC], mandate: { ...live, allowed: false, reason: 'withdrawn' } }) });
    await u.open();
    expect(u.body().all().find((e) => e.textContent === 'Contrôler avant signature')).toBeDefined();
  });

  it('[R40] un document d’essai est dit tel, et son contrôle le dit aussi', async () => {
    const t = await run({
      'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [{ ...DOC, mode: 'essai', status: 'incomplet', missing: ['bien.prix'] }] }),
      'POST /v1/documents/d1/controle': ok({ ...FAILED, lines: [{ check: 'modele', ok: false, code: 'trial_template' }] }),
    });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('Document d’essai : il ne se signe pas.');
    expect(text).toContain('Il manque : prix du bien.');
    await t.press('Contrôler avant signature');
    expect(t.body().textContent).toContain('À régler : Document d’essai');
  });

  it('[R39] [R10] après un contrôle réussi : le scan part d’abord, sa référence rendue sert à la signature, et le numéro vient du code', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/biens/b1/scans-mandat': ok({ ref: 'mandats/b1/s.pdf' }), [SIGN]: ok({ number: 'T-007' }) });
    await t.open();
    await t.press('Contrôler avant signature');
    expect(t.state()).toContain('Contrôle réussi');
    await t.press('Enregistrer la signature');
    expect(t.state()).toBe('Dites le jour de la signature.');
    t.fillSign();
    t.table['GET /v1/biens/b1/mandat'] = ok({
      ...READ,
      documents: [{ ...DOC, signature: { signedAt: '2027-02-10T12:00:00.000Z', place: 'agence', number: 'T-007', complete: true } }],
      mandate: { id: 'm1', number: 'T-007', signedAt: '2027-02-10T12:00:00.000Z', allowed: false, reason: 'withdrawal_period' },
    });
    await t.press('Enregistrer la signature');
    const posts = t.posts();
    expect(posts[1]!.url).toBe('/v1/biens/b1/scans-mandat');
    expect(posts[2]).toEqual({ method: 'POST', url: '/v1/documents/d1/signature-papier', body: { signedAt: '2027-02-10T12:00:00.000Z', place: 'agence', scanRef: 'mandats/b1/s.pdf', source: 'referral' } });
    expect(t.state()).toBe('Mandat signé : n° T-007 au registre.');
    const text = t.body().textContent;
    expect(text).toContain('Numéro au registre : T-007');
    expect(text).toContain('Délai de rétractation en cours');
    // Un mandat vivant : pas de second mandat à préparer.
    expect(text).not.toContain('Préparer un mandat');
  });

  it('[R10] un scan refusé est redemandé ; un fichier non admis ne part pas', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/biens/b1/scans-mandat': ok({ ref: 'mandats/b1/s.pdf' }), [SIGN]: no(400, 'scan_absent') });
    await t.open();
    await t.press('Contrôler avant signature');
    t.fillSign(pdf('text/plain'));
    await t.press('Enregistrer la signature');
    expect(t.state()).toContain('PDF, JPEG ou PNG');
    expect(t.calls.filter((c) => c.url.includes('scans-mandat'))).toEqual([]);
    t.fillSign();
    await t.press('Enregistrer la signature');
    expect(t.state()).toBe('Le scan n’est pas rangé : choisissez-le de nouveau.');
    await t.press('Enregistrer la signature');
    expect(t.calls.filter((c) => c.url.includes('scans-mandat')).length).toBe(2);
  });

  it('[R10] sans stockage, l’écran le dit et rien ne se signe', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/biens/b1/scans-mandat': no(503, 'depot_ferme') });
    await t.open();
    await t.press('Contrôler avant signature');
    t.fillSign();
    await t.press('Enregistrer la signature');
    expect(t.state()).toContain('rien ne se signe sans le scan');
    expect(t.calls.filter((c) => c.url.endsWith('signature-papier'))).toEqual([]);
  });

  it('[R41] le contrôle change entre-temps : la ligne est dite et le formulaire s’en va', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/biens/b1/scans-mandat': ok({ ref: 'mandats/b1/s.pdf' }), [SIGN]: no(400, 'checks_failed', { check: FAILED }) });
    await t.open();
    await t.press('Contrôler avant signature');
    t.fillSign();
    await t.press('Enregistrer la signature');
    expect(t.state()).toContain('n’est plus réglé');
    expect(t.body().textContent).toContain('À régler : L’identité');
    expect(t.body().all().find((e) => e.textContent === 'Enregistrer la signature')).toBeUndefined();
  });

  it('[R38] un enregistrement arrêté n’est pas dit signé ; il reprend sans redéposer, avec sa date et son lieu', async () => {
    const stopped = { signedAt: '2027-02-10T12:00:00.000Z', place: 'hors_agence', number: null, complete: false };
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [{ ...DOC, signature: stopped }] }), [SIGN]: ok({ number: 'T-008' }) });
    await t.open();
    expect(t.body().textContent).toContain('n’est pas encore signé');
    expect(t.body().textContent).not.toContain('Signé le');
    await t.press('Reprendre l’enregistrement');
    t.input('mandat-source-d1').value = 'other';
    t.input('mandat-precision-d1').value = 'Un voisin';
    await t.press('Finir l’enregistrement');
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/documents/d1/signature-papier', body: { signedAt: stopped.signedAt, place: 'hors_agence', scanRef: 'mandats/reprise', source: 'other', sourceDetail: 'Un voisin' } }]);
    expect(t.calls.filter((c) => c.url.includes('scans-mandat'))).toEqual([]);
  });

  it('l’exemplaire se lit en texte : aucune balise reçue n’est interprétée', async () => {
    const signed = { signedAt: '2027-02-10T12:00:00.000Z', place: 'agence', number: 'T-007', complete: true };
    const t = await run({
      'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [{ ...DOC, signature: signed }], mandate: { id: 'm1', number: 'T-007', signedAt: signed.signedAt, allowed: true, reason: 'allowed' } }),
      'GET /v1/documents/d1/exemplaire': ok({ number: 'T-007', content: '<!doctype html><html><head><title>Titre caché</title><style>p{}</style></head><body><p>Numéro : <span class="signe">T-007</span></p><p>L&#39;honoraire &amp; &lt;b&gt;</p></body></html>' }),
    });
    await t.open();
    expect(t.body().textContent).toContain('Signé le 10 février 2027, à l’agence, n° T-007.');
    expect(t.body().all().find((e) => e.textContent === 'Contrôler avant signature')).toBeUndefined();
    await t.press('Voir l’exemplaire');
    const text = t.body().textContent;
    expect(text).toContain('Numéro : T-007');
    expect(text).toContain("L'honoraire & <b>");
    expect(text).not.toContain('Titre caché');
    expect(text).not.toContain('<span');
  });

  it('[R39] un second mandat refusé par le code est dit en français', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': ok({ ...READ, documents: [DOC] }), 'POST /v1/biens/b1/scans-mandat': ok({ ref: 'mandats/b1/s.pdf' }), [SIGN]: no(400, 'mandate_in_force') });
    await t.open();
    await t.press('Contrôler avant signature');
    t.fillSign();
    await t.press('Enregistrer la signature');
    expect(t.state()).toBe('Un mandat est déjà en cours sur ce bien : ce document ne se signe pas.');
  });

  it('[R41] la signature en ligne n’existe pas sur cet écran tant que l’avocat ne l’a pas validée (H24)', () => {
    expect(MANDAT_SCRIPT).not.toContain('signature-en-ligne');
  });

  it('[R16] une lecture refusée n’est pas montrée comme un bien sans mandat ; quitter l’écran n’y laisse rien', async () => {
    const t = await run({ 'GET /v1/biens/b1/mandat': no(403, 'not_assigned') });
    await t.open();
    expect(t.state()).toBe('Ce mandat n’est pas dans vos droits.');
    expect(t.body().textContent).toBe('');
    t.table['GET /v1/biens/b1/mandat'] = ok(READ);
    await t.click(t.els['mandat-retour']);
    expect(t.state()).toBe('');
    expect(t.els.mandat!.hidden).toBe(true);
  });

  describe('D16 · rétractation et début anticipé', () => {
    const SIGNED = { ...DOC, signature: { signedAt: '2027-02-10T09:00:00.000Z', place: 'hors_agence', number: 'AV-7', complete: true } };
    const live = (reason: string, last: string | null = '2027-02-24') => ok({ ...READ, documents: [SIGNED], mandate: { id: 'm1', number: 'AV-7', signedAt: '2027-02-10T09:00:00.000Z', allowed: reason !== 'withdrawal_period', reason, withdrawalLastDay: last } });
    const OPEN_EARLY = 'Noter sa demande de commencer tout de suite';
    const OPEN_STOP = 'Noter une rétractation';
    const WITHDRAW = 'POST /v1/mandats/m1/retractation';
    const EARLY = 'POST /v1/mandats/m1/debut-anticipe';
    const buttons = (t: Awaited<ReturnType<typeof run>>) => t.body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
    const opened = async (reason = 'withdrawal_period', answers: Record<string, Answer> = {}) => {
      const t = await run({ 'GET /v1/biens/b1/mandat': live(reason), ...answers });
      await t.open();
      return t;
    };
    const fill = (t: Awaited<ReturnType<typeof run>>, day: string, proof: string) => {
      t.input('mandat-arret-jour').value = day;
      t.input('mandat-arret-preuve').value = proof;
    };

    it('[R42] le dernier jour du délai est dit, et les deux gestes sont là pendant le délai', async () => {
      const t = await opened();
      expect(t.body().textContent).toContain('Dernier jour du délai de rétractation : 24 février 2027.');
      expect(buttons(t)).toEqual(expect.arrayContaining([OPEN_EARLY, OPEN_STOP]));
    });

    it('[R42] après une demande notée, ou le délai fini, seule la rétractation reste : une lettre reçue à temps peut arriver tard', async () => {
      for (const reason of ['allowed_early_start', 'allowed']) {
        const t = await opened(reason);
        expect(buttons(t)).toContain(OPEN_STOP);
        expect(buttons(t)).not.toContain(OPEN_EARLY);
      }
    });

    it('[R42] aucun geste à l’agence, ni sur un mandat rétracté, annulé, échu ou hors registre', async () => {
      const agence = await run({ 'GET /v1/biens/b1/mandat': live('allowed', null) });
      await agence.open();
      expect(agence.body().textContent).not.toContain('Dernier jour');
      expect(buttons(agence)).not.toContain(OPEN_STOP);
      for (const reason of ['withdrawn', 'cancelled', 'expired', 'no_mandate', 'duration_unknown']) {
        const t = await opened(reason);
        expect(buttons(t)).not.toContain(OPEN_STOP);
        expect(buttons(t)).not.toContain(OPEN_EARLY);
      }
    });

    it('[R42] une rétractation demande deux appuis, dit ce qu’elle arrête, et « Ne rien noter » n’envoie rien', async () => {
      const t = await opened();
      await t.press(OPEN_STOP);
      fill(t, '2027-02-12', 'Lettre recommandée du 11 février');
      await t.press('Noter la rétractation');
      expect(t.posts()).toEqual([]);
      expect(t.body().textContent).toContain('Rétractation reçue le 12 février 2027');
      expect(t.body().textContent).toContain('son numéro est annulé au registre');
      expect(t.body().textContent).toContain('Cela ne se défait pas.');
      await t.press('Ne rien noter');
      expect(t.posts()).toEqual([]);
      expect(buttons(t)).toContain(OPEN_STOP);
    });

    it('[R16, R42] le second appui note ce qui était saisi, sans identifiant à taper, puis l’écran relit le mandat', async () => {
      const t = await opened('withdrawal_period', { [WITHDRAW]: ok(null) });
      await t.press(OPEN_STOP);
      fill(t, '2027-02-12', '  Lettre recommandée du 11 février  ');
      await t.press('Noter la rétractation');
      t.table['GET /v1/biens/b1/mandat'] = live('withdrawn', null);
      await t.press('Confirmer : noter la rétractation');
      expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/mandats/m1/retractation', body: { proof: 'Lettre recommandée du 11 février', receivedAt: '2027-02-12T21:00:00.000Z' } }]);
      expect(t.state()).toContain('Rétractation notée');
      expect(t.body().textContent).toContain('Le mandant s’est rétracté');
      expect(buttons(t)).not.toContain(OPEN_STOP);
    });

    it('[R42] la demande de commencer part en un appui ; reçue aujourd’hui, elle vaut l’instant présent', async () => {
      const t = await opened('withdrawal_period', { [EARLY]: ok(null) });
      await t.press(OPEN_EARLY);
      const today = t.input('mandat-arret-jour').value;
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      t.input('mandat-arret-preuve').value = 'Mail du vendeur';
      t.table['GET /v1/biens/b1/mandat'] = live('allowed_early_start');
      const before = Date.now();
      await t.press('Noter la demande');
      const [sent] = t.posts();
      expect(sent!.url).toBe('/v1/mandats/m1/debut-anticipe');
      expect(Date.parse((sent!.body as { receivedAt: string }).receivedAt)).toBeGreaterThanOrEqual(before);
      expect(t.state()).toContain('Demande notée');
      expect(t.body().textContent).toContain('le mandant a demandé de commencer tout de suite');
    });

    it('une preuve vide ou une date vide ne part pas, et le dit', async () => {
      const t = await opened();
      await t.press(OPEN_EARLY);
      fill(t, '2027-02-12', '   ');
      await t.press('Noter la demande');
      expect(t.state()).toContain('la preuve écrite');
      fill(t, '', 'Mail');
      await t.press('Noter la demande');
      expect(t.state()).toContain('La date');
      expect(t.posts()).toEqual([]);
    });

    it('[R42] chaque refus du code est dit en français, et le formulaire reste', async () => {
      const said: Record<string, string> = {
        delay_over: 'après le dernier jour du délai',
        bad_date: 'depuis la signature',
        bad_proof: 'la preuve écrite',
        no_withdrawal_period: 'signé à l’agence',
        withdrawn: 'déjà rétracté',
      };
      for (const [code, text] of Object.entries(said)) {
        const t = await opened('withdrawal_period', { [EARLY]: no(400, code) });
        await t.press(OPEN_EARLY);
        fill(t, '2027-02-12', 'Mail');
        await t.press('Noter la demande');
        expect(t.state()).toContain(text);
        expect(buttons(t)).toContain('Noter la demande');
      }
      const r = await opened('withdrawal_period', { [EARLY]: no(403, 'not_assigned') });
      await r.press(OPEN_EARLY);
      fill(r, '2027-02-12', 'Mail');
      await r.press('Noter la demande');
      expect(r.state()).toContain('pas dans vos droits');
    });

    it('une réponse perdue n’est pas dite « rien n’est rangé » ; le second essai dit « déjà notée » et relit', async () => {
      const t = await opened('withdrawal_period', { [EARLY]: () => Promise.reject(new TypeError('coupure')) });
      await t.press(OPEN_EARLY);
      fill(t, '2027-02-12', 'Mail');
      await t.press('Noter la demande');
      expect(t.state()).toContain('peut-être rangée');
      expect(t.state()).not.toContain('rien n’est');
      t.table[EARLY] = no(409, 'already_recorded');
      t.table['GET /v1/biens/b1/mandat'] = live('allowed_early_start');
      await t.press('Noter la demande');
      expect(t.state()).toContain('déjà notée');
      expect(buttons(t)).not.toContain(OPEN_EARLY);
    });

    it('un second appui pendant l’envoi ne part pas deux fois', async () => {
      let free: (r: Response) => void = () => {};
      const t = await opened('withdrawal_period', { [EARLY]: () => new Promise<Response>((r) => { free = r; }) });
      await t.press(OPEN_EARLY);
      fill(t, '2027-02-12', 'Mail');
      await t.press('Noter la demande');
      await t.press('Noter la demande');
      expect(t.posts()).toHaveLength(1);
      free(Response.json({ ok: true, mode: 'essai', data: null }));
    });
  });
});

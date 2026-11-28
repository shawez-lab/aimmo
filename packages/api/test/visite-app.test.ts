import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : visite, bien, acquéreurs, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Call = { method: string; url: string; body: any };
type Answer = (body: any) => Promise<Response>;

const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', sent: false, data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const RDV = {
  day: '2027-03-03',
  appointments: [{ id: 'v1', kind: 'visite', start: '2027-03-03T13:00:00.000Z', end: '2027-03-03T14:00:00.000Z', status: 'booked', firstName: 'Inès', brief: null, briefMissing: 'not_ready' }],
};
const VISIT = {
  appointmentId: 'v1',
  start: '2027-03-03T13:00:00.000Z',
  end: '2027-03-03T14:00:00.000Z',
  status: 'booked',
  property: { id: 'b1', reference: 'REF-T-1', city: 'Dijon' },
  projectId: 'pr1',
  visitor: { firstName: 'Inès' },
  slip: { status: 'complet', mode: 'essai', signed: false },
  safety: 'a_confirmer',
  report: null,
};
const REPORT = { opinion: 'Le visiteur a aimé la lumière du séjour.', strengths: ['séjour lumineux'], reservations: ['cuisine à refaire'], interest: 'fort', readyToOffer: false };
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok(RDV),
  'GET /v1/usage/matin': ok(null),
};

async function run(answers: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    crypto: globalThis.crypto,
    setTimeout: (f: () => void, ms: number) => (ms === 0 ? setTimeout(f, 0) : 0),
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method, url, body });
      const answer = table[`${method} ${url}`] ?? Object.entries(table).find(([k]) => k.endsWith('*') && `${method} ${url}`.startsWith(k.slice(0, -1)))?.[1];
      return answer ? answer(body) : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const find = (root: FakeElement, pred: (e: FakeElement) => boolean) => root.all().find(pred);
  const byText = (root: FakeElement, text: string) => {
    const b = find(root, (e) => e.tagName === 'button' && e.textContent === text);
    if (!b) throw new Error(`bouton absent : ${text}`);
    return b;
  };
  const byId = (root: FakeElement, id: string) => find(root, (e) => e.attributes.id === id)!;
  const click = async (b: FakeElement) => {
    b.listeners.click!({});
    await settle();
  };
  return { els, storage, calls, table, byText, byId, click };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

async function openVisit(answers: Record<string, Answer>) {
  const t = await run(answers);
  await t.click(t.byText(t.els.rdv!, 'Ouvrir la visite'));
  return t;
}

describe('T08 · écran de la visite', () => {
  it('depuis la journée, la visite s’ouvre : bien, heure, visiteur, sécurité, compte rendu, bon ; aucun code interne affiché', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok(VISIT) });
    expect(t.els.visite!.hidden).toBe(false);
    expect(t.els['visite-titre']!.textContent).toBe('Visite');
    expect(t.els['visite-bien']!.textContent).toBe('Réf. REF-T-1 · Dijon');
    const text = t.els['visite-corps']!.textContent;
    expect(text).toContain('14:00 à 15:00 · avec Inès');
    expect(text).toContain('Avant d’ouvrir la porte, le visiteur confirme son téléphone et son identité.');
    expect(text).toContain('Bon de visite prêt à signer (modèle d’essai, en attente de validation juridique).');
    expect(text).not.toMatch(/a_confirmer|complet\b|essai'|booked/);
    // L'alerte en un geste est là, en tête de l'écran.
    expect(HTML).toContain('<button id="alerte" type="button" class="danger">Alerte sécurité</button>');
  });

  it('DS023 · le bien de la visite se dit par ce qu’il est quand la journée le connaît, sinon par sa référence et sa commune ; jamais dans le titre', async () => {
    // Le bien visité est dans « Mes biens » de la journée : son nom est connu, la visite le dit.
    const known = await openVisit({ 'GET /v1/visites/v1': ok(VISIT), 'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: 'en_vente', kind: 'home', rooms: 5, dwelling: 'house' }]) });
    expect(known.els['visite-titre']!.textContent).toBe('Visite');
    expect(known.els['visite-bien']!.textContent).toBe('Maison 5 pièces · Dijon · Réf. REF-T-1');
    // De la visite aux acquéreurs du bien : même ligne, sous un titre qui ne porte plus la référence.
    await known.click(known.byText(known.els['visite-corps']!, 'Acquéreurs pour ce bien'));
    expect(known.els['bien-titre']!.textContent).toBe('Acquéreurs pour ce bien');
    expect(known.els['bien-bien']!.textContent).toBe('Maison 5 pièces · Dijon · Réf. REF-T-1');
    expect(known.els['visite-bien']!.textContent).toBe('');
    // Un bien que la journée ne liste pas : sa référence et sa commune, sans nom deviné.
    const unknown = await openVisit({ 'GET /v1/visites/v1': ok(VISIT) });
    expect(unknown.els['visite-bien']!.textContent).toBe('Réf. REF-T-1 · Dijon');
    // Un bien sorti des droits de l'agent : aucune ligne.
    const gone = await openVisit({ 'GET /v1/visites/v1': ok({ ...VISIT, property: null }) });
    expect(gone.els['visite-bien']!.textContent).toBe('');
    // Sortir efface la ligne avec le reste.
    await known.click(known.els.sortir!);
    for (const id of ['visite-bien', 'bien-bien']) expect(known.els[id]!.textContent, id).toBe('');
  });

  it('[R54] le code ne part qu’avec l’accord du visiteur coché ; puis code et nom sont saisis ; un refus est dit en clair', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok(VISIT), 'POST /v1/visites/v1/code': ok({ expiresAt: '2027-03-03T13:10:00.000Z' }) });
    const send = t.byText(t.els['visite-corps']!, 'Envoyer le code au visiteur');
    await t.click(send);
    expect(t.els['visite-etat']!.textContent).toBe('Cochez d’abord l’accord du visiteur.');
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([]);
    t.byId(t.els['visite-corps']!, 'v-accord').checked = true;
    t.table['GET /v1/visites/v1'] = ok({ ...VISIT, safety: 'code_envoye' });
    await t.click(send);
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', url: '/v1/visites/v1/code', body: { consentProof: expect.stringContaining('Accord du visiteur') } }]);
    expect(t.els['visite-corps']!.textContent).toContain('Le visiteur a reçu un code par SMS.');
    t.table['POST /v1/visites/v1/confirmation'] = no(409, { ok: false, rule: 'R54', code: 'bad_identity' });
    t.byId(t.els['visite-corps']!, 'v-code').value = ' 123456 ';
    t.byId(t.els['visite-corps']!, 'v-nom').value = 'Martin';
    await t.click(t.byText(t.els['visite-corps']!, 'Confirmer la visite'));
    expect(t.calls.at(-1)).toEqual({ method: 'POST', url: '/v1/visites/v1/confirmation', body: { code: '123456', lastName: 'Martin' } });
    expect(t.els['visite-etat']!.textContent).toBe('Ce nom n’est pas celui de la fiche du visiteur.');
  });

  it('[R52] compte rendu rédigé : relu puis validé en un seul geste ; envoyé au vendeur sans le nom', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok({ ...VISIT, safety: 'confirmee', report: { status: 'brouillon', source: 'ai', report: REPORT, delivery: null } }) });
    const corps = t.els['visite-corps']!;
    expect(corps.textContent).toContain('Téléphone et identité du visiteur confirmés.');
    expect(corps.textContent).toContain('Points forts : séjour lumineux');
    t.table['POST /v1/visites/v1/compte-rendu/validation'] = ok({ delivery: 'sent', rule: null });
    t.table['GET /v1/visites/v1'] = ok({ ...VISIT, safety: 'confirmee', report: { status: 'valide', source: 'ai', report: REPORT, delivery: 'sent' } });
    await t.click(t.byText(corps, 'Valider et envoyer au vendeur'));
    expect(t.calls.at(-2)).toEqual({ method: 'POST', url: '/v1/visites/v1/compte-rendu/validation', body: {} });
    expect(corps.textContent).toContain('Envoyé au vendeur, sans le nom du visiteur.');
    expect(corps.all().some((e) => e.tagName === 'button' && e.textContent === 'Valider et envoyer au vendeur')).toBe(false);
  });

  it('dictée par le micro du clavier ; sans rédaction possible, l’agent écrit lui-même ; un refus [R52] est expliqué', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok(VISIT) });
    const corps = t.els['visite-corps']!;
    expect(corps.textContent).toContain('Touchez le micro du clavier et parlez');
    await t.click(t.byText(corps, 'Envoyer la dictée'));
    expect(t.els['visite-etat']!.textContent).toBe('Dictez d’abord ce que le visiteur a dit.');
    t.byId(corps, 'v-dictee').value = 'Elle a aimé le séjour, cuisine à refaire.';
    t.table['POST /v1/visites/v1/compte-rendu/dictee'] = ok({ report: null, source: null });
    t.table['GET /v1/visites/v1'] = ok({ ...VISIT, report: { status: 'brouillon', source: null, report: null, delivery: null } });
    await t.click(t.byText(corps, 'Envoyer la dictée'));
    expect(t.calls.find((c) => c.url.endsWith('/dictee'))!.body).toEqual({ dictation: 'Elle a aimé le séjour, cuisine à refaire.' });
    expect(corps.textContent).toContain('Dictée gardée');
    t.byId(corps, 'v-avis').value = 'Inès a aimé le séjour.';
    t.byId(corps, 'v-forts').value = 'séjour, , lumière';
    t.byId(corps, 'v-interet').value = 'fort';
    t.table['POST /v1/visites/v1/compte-rendu/validation'] = no(409, { ok: false, rule: 'R52', code: 'buyer_named' });
    await t.click(t.byText(corps, 'Valider et envoyer au vendeur'));
    expect(t.calls.at(-1)!.body).toEqual({ report: { opinion: 'Inès a aimé le séjour.', strengths: ['séjour', 'lumière'], reservations: [], interest: 'fort', readyToOffer: false } });
    expect(t.els['visite-etat']!.textContent).toBe('Le compte rendu nomme le visiteur : retirez son nom avant l’envoi au vendeur.');
  });

  it('l’alerte en un geste : un appui, sans confirmation ; sans réseau, le même identifiant sert au nouvel appui', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok(VISIT) });
    await t.click(t.els.alerte!);
    const first = t.calls.at(-1)!;
    expect(first.method).toBe('POST');
    expect(first.url).toMatch(/^\/v1\/visites\/alertes\/al-[0-9a-f]{32}$/);
    expect(t.els['alerte-etat']!.textContent).toContain('Appuyez de nouveau, ou appelez le 112');
    // En mode essai, l'écran dit que la direction n'est pas prévenue par message, et donne le 112.
    t.table[`POST ${first.url}`] = ok({ recorded: true, notified: true, trial: true });
    await t.click(t.els.alerte!);
    expect(t.calls.at(-1)!.url).toBe(first.url);
    expect(t.els['alerte-etat']!.textContent).toBe('Mode essai : l’alerte est enregistrée, mais la direction n’est pas encore prévenue par message. Appelez le 112 si vous êtes en danger.');
    t.table['POST /v1/visites/alertes/*'] = ok({ recorded: true, notified: true, trial: false });
    await t.click(t.els.alerte!);
    const second = t.calls.at(-1)!.url;
    expect(second).not.toBe(first.url);
    expect(t.els['alerte-etat']!.textContent).toBe('Alerte reçue : la direction est prévenue. Appelez le 112 si vous êtes en danger.');
    t.table[`POST ${second}`] = ok({ recorded: true, notified: true, trial: false });
    t.table['POST /v1/visites/alertes/*'] = ok({ recorded: true, notified: false, trial: false });
    await t.click(t.els.alerte!);
    expect(t.calls.at(-1)!.url).not.toBe(second);
    expect(t.els['alerte-etat']!.textContent).toContain('sera prévenue dès que possible');
  });

  it('l’identifiant d’une alerte non aboutie ne survit pas à la sortie ; un identifiant refusé [R16] est remplacé une fois', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok(VISIT) });
    await t.click(t.els.alerte!);
    const lost = t.calls.at(-1)!.url;
    await t.click(t.els.sortir!);
    t.table[`POST ${lost}`] = no(403, { ok: false, rule: 'R16', code: 'not_assigned' });
    t.table['POST /v1/visites/alertes/*'] = ok({ recorded: true, notified: true, trial: false });
    t.els.cle!.value = 'n'.repeat(40);
    t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    await t.click(t.byText(t.els.rdv!, 'Ouvrir la visite'));
    await t.click(t.els.alerte!);
    const after = t.calls.filter((c) => c.url.startsWith('/v1/visites/alertes/')).map((c) => c.url);
    expect(after.at(-1)).not.toBe(lost);
    expect(t.els['alerte-etat']!.textContent).toMatch(/^Alerte reçue : la direction est prévenue/);
    // Sur le même téléphone : un identifiant refusé, puis un nouveau, une seule fois.
    const u = await openVisit({ 'GET /v1/visites/v1': ok(VISIT), 'POST /v1/visites/alertes/*': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await u.click(u.els.alerte!);
    const tries = u.calls.filter((c) => c.url.startsWith('/v1/visites/alertes/')).map((c) => c.url);
    expect(tries).toHaveLength(2);
    expect(tries[0]).not.toBe(tries[1]);
    expect(u.els['alerte-etat']!.textContent).toContain('le 112');
  });

  it('[R16] une clé refusée pendant la visite efface l’écran et la clé ; une visite hors des droits est dite', async () => {
    const denied = await openVisit({ 'GET /v1/visites/v1': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    expect(denied.els['visite-etat']!.textContent).toBe('Cette visite n’est pas dans vos droits.');
    const online = await openVisit({ 'GET /v1/visites/v1': no(404, { ok: false, rule: 'R16', code: 'unknown' }) });
    expect(online.els['visite-etat']!.textContent).toMatch(/^Pas de dossier de visite pour ce rendez-vous/);
    const refused = await openVisit({ 'GET /v1/visites/v1': no(401, { ok: false, code: 'unauthorized' }) });
    expect(refused.els.connexion!.hidden).toBe(false);
    expect(refused.storage.has('aimmo.cle')).toBe(false);
    expect(refused.els['visite-corps']!.children).toEqual([]);
  });
});

describe('T08 · visite sans prénom', () => {
  it('un bien qui n’est plus dans les droits : la visite reste ouverte pour la sécurité, sans le bien ni ses acquéreurs', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok({ ...VISIT, property: null }) });
    expect(t.els['visite-titre']!.textContent).toBe('Visite');
    expect(t.els['visite-corps']!.textContent).toContain('Le bien n’est plus dans vos droits');
    expect(t.els['visite-corps']!.all().some((e) => e.textContent === 'Acquéreurs pour ce bien')).toBe(false);
  });

  it('le prénom n’est pas un droit : une visite sans prénom s’ouvre, la route contrôle l’accès', async () => {
    const t = await run({ 'GET /v1/rendez-vous/jour': ok({ ...RDV, appointments: [{ ...RDV.appointments[0], firstName: null }] }), 'GET /v1/visites/v1': ok({ ...VISIT, visitor: { firstName: null } }) });
    await t.click(t.byText(t.els.rdv!, 'Ouvrir la visite'));
    expect(t.els['visite-titre']!.textContent).toBe('Visite');
    expect(t.els['visite-bien']!.textContent).toBe('Réf. REF-T-1 · Dijon');
  });
});

describe('T08 · écran des acquéreurs d’un bien', () => {
  const BUYERS = [
    { rank: 1, projectId: 'pr2', personId: 'p2', firstName: 'Zoé', status: 'match', reasons: ['Prix dans le budget.'], featuresMet: [] },
    { rank: 2, projectId: 'pr1', personId: 'p1', firstName: INJECTED, status: 'tolerated', reasons: ['Surface 5 % sous le minimum, dans la tolérance de 10 %.'], featuresMet: [] },
  ];
  const MAP = { activeBuyers: 7, matching: 2, nearMisses: [{ criterion: 'budget', count: 3 }] };
  const answers = (link: string): Record<string, Answer> => ({
    'GET /v1/visites/v1': ok(VISIT),
    'GET /v1/acquereurs/biens/b1': ok(BUYERS),
    'GET /v1/acquereurs/biens/b1/carte': ok(MAP),
    'POST /v1/acquereurs/biens/b1/whatsapp/pr2': ok({ link, messageId: 'm1' }),
    'POST /v1/acquereurs/whatsapp/m1/envoye': ok({ confirmedAt: '2027-03-02T09:00:00.000Z' }),
  });
  const open = async (link = 'https://wa.me/33600000001?text=Bonjour%20Zo%C3%A9') => {
    const t = await openVisit(answers(link));
    // DS022 · ce geste mène ailleurs : il est filaire, pas un pas de la visite.
    expect(t.byText(t.els['visite-corps']!, 'Acquéreurs pour ce bien')!.className).toBe('secondaire');
    await t.click(t.byText(t.els['visite-corps']!, 'Acquéreurs pour ce bien'));
    return t;
  };

  it('[R51] les acquéreurs dans l’ordre du rapprochement, avec leurs raisons, et la carte de la demande ; un texte reste un texte', async () => {
    const t = await open();
    expect(t.els.bien!.hidden).toBe(false);
    expect(t.els['bien-titre']!.textContent).toBe('Acquéreurs pour ce bien');
    expect(t.els['bien-bien']!.textContent).toBe('Réf. REF-T-1');
    const corps = t.els['bien-corps']!;
    expect(corps.textContent).toContain('2 acquéreur(s) sur 7 recherche(s) active(s) du réseau.');
    expect(corps.textContent).toContain('3 écarté(s) par un seul critère : budget.');
    const rows = corps.all().filter((e) => e.className === 'acquereur');
    expect(rows.map((r) => r.children[0]!.textContent)).toEqual(['1. Zoé · remplit tous les critères', `2. ${INJECTED} · dans les tolérances écrites`]);
    expect(corps.all().map((e) => e.tagName).filter((x) => !['section', 'h3', 'p', 'ol', 'li', 'strong', 'ul', 'button'].includes(x))).toEqual([]);
  });

  it('alerte WhatsApp : le lien après le contrôle central, ouvert par l’agent, puis « message envoyé » noté une fois', async () => {
    const t = await open();
    const row = t.els['bien-corps']!.all().filter((e) => e.className === 'acquereur')[0]!;
    await t.click(t.byText(row, 'Alerte WhatsApp'));
    const link = row.all().find((e) => e.tagName === 'a')!;
    expect(link.attributes).toEqual({ href: 'https://wa.me/33600000001?text=Bonjour%20Zo%C3%A9', target: '_blank', rel: 'noopener noreferrer' });
    // Le lien ne sert qu'une fois : ouvert, il disparaît ; rien ne permet de renvoyer plus tard sans nouveau contrôle.
    link.listeners.click!({});
    await settle();
    expect(row.all().some((e) => e.tagName === 'a')).toBe(false);
    await t.click(t.byText(row, 'Message envoyé'));
    expect(t.calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/acquereurs/whatsapp/m1/envoye' });
    expect(row.textContent).toContain('Envoi noté : ce bien ne lui sera plus proposé.');
    expect(row.all().some((e) => e.tagName === 'button' && e.textContent === 'Message envoyé')).toBe(false);
    // Un lien jamais ouvert expire : il ne reste pas à l'écran au-delà de deux minutes.
    expect(AGENT_APP_FILES['/app/app.js']).toContain('var LINK_TTL_MS = 120000;');
  });

  it('un lien qui n’est pas WhatsApp n’est jamais ouvert ; un refus du contrôle central est dit avec sa raison', async () => {
    const t = await open('javascript:alert(1)');
    const row = t.els['bien-corps']!.all().filter((e) => e.className === 'acquereur')[0]!;
    await t.click(t.byText(row, 'Alerte WhatsApp'));
    expect(row.all().some((e) => e.tagName === 'a')).toBe(false);
    expect(row.textContent).toContain('Le lien reçu n’est pas un lien WhatsApp');
    t.table['POST /v1/acquereurs/biens/b1/whatsapp/pr2'] = no(409, { ok: false, rule: 'R49', code: 'refused', reason: 'Aucun accord en cours pour ce canal.' });
    await t.click(t.byText(row, 'Alerte WhatsApp'));
    expect(row.textContent).toContain('Aucun accord en cours pour ce canal.');
  });

  it('[R42] un bien pas encore diffusable est dit ; le retour ramène à la visite', async () => {
    const t = await openVisit({ ...answers('x'), 'GET /v1/acquereurs/biens/b1': no(409, { ok: false, rule: 'R42', code: 'withdrawal_period' }) });
    await t.click(t.byText(t.els['visite-corps']!, 'Acquéreurs pour ce bien'));
    expect(t.els['bien-etat']!.textContent).toMatch(/rétractation en cours/);
    await t.click(t.els['bien-retour']!);
    expect(t.els.visite!.hidden).toBe(false);
  });
});

describe('T08 · écrans accessibles et faits pour le téléphone', () => {
  it('chaque champ a son libellé ; cibles de 44 px ; focus visible ; l’alerte se distingue', async () => {
    const t = await openVisit({ 'GET /v1/visites/v1': ok({ ...VISIT, safety: 'code_envoye', report: { status: 'brouillon', source: null, report: null, delivery: null } }) });
    const corps = t.els['visite-corps']!;
    const fields = corps.all().filter((e) => ['input', 'textarea', 'select'].includes(e.tagName));
    expect(fields.length).toBeGreaterThanOrEqual(7);
    for (const f of fields) expect(corps.all().some((l) => l.tagName === 'label' && l.attributes.for === f.attributes.id), f.attributes.id).toBe(true);
    const css = AGENT_APP_FILES['/app/app.css']!;
    // Les mesures et les couleurs viennent du système de design (Z03).
    expect(css).toContain('--cible:48px');
    expect(css).toMatch(/(?:^|\})button,\.appel\{[^}]*min-height:var\(--cible\)/);
    expect(css).toMatch(/input,select,textarea\{[^}]*min-height:var\(--cible\)/);
    expect(css).toMatch(/:focus-visible\{outline:3px solid var\(--anneau\)/);
    expect(css).toMatch(/button\.danger,\.danger\{[^}]*background:var\(--danger\)/);
    expect(HTML).toContain('<p id="alerte-etat" role="alert" hidden></p>');
  });
});

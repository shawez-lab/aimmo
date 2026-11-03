import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { PROJECT_KINDS } from '../../core/src/db/types.ts';
import { PARTNER_RECOMMENDATION_FIELDS, RECOMMENDATION_CONSENT_CHANNELS, RECOMMENDATION_CONSENT_FIELDS, RECOMMENDATION_CONSENT_KINDS } from '../../core/src/mandats/gagner/recommandations.ts';
import { describe, expect, it } from 'vitest';
import { PARTNER_SPACE_FILES } from '../src/partenaires.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = PARTNER_SPACE_FILES['/partenaire/']!;
const JS = PARTNER_SPACE_FILES['/partenaire/partenaire.js']!;
const POST = '/v1/gagner/recommandations';
const SENT = '/v1/gagner/recommandations/mes-envois';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string, rule: string | null = null): Answer => async () => Response.json({ ok: false, rule, code }, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));
const settle = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(posts: Answer[] = [], sents: Answer[] = [ok([])], over: { Date?: DateConstructor } = {}) {
  let onStorage: (e: { key: string | null }) => void = () => {};
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.partenaire.cle', KEY]]);
  const calls: { method: string; url: string; body: Record<string, any> | null }[] = [];
  const context: Record<string, unknown> = {
    document,
    Date: over.Date ?? Date,
    addEventListener: (name: string, fn: (e: { key: string | null }) => void) => { if (name === 'storage') onStorage = fn; },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      if (url === '/v1/partenaires/espace') return ok([])();
      if (url === SENT) return (sents.length > 1 ? sents.shift()! : sents[0] ?? offline)();
      if (url === POST) return (posts.shift() ?? offline)();
      return offline();
    },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const fill = (over: Record<string, string> = {}) => {
    const values: Record<string, string> = { 'reco-mail': 'nina@example.test', 'reco-projet': 'buy', 'reco-preuve': 'message_ecrit', 'reco-canal': 'email', 'reco-jour': '2020-05-04', 'reco-reference': 'courriel du 4 mai', ...over };
    for (const [id, value] of Object.entries(values)) els[id]!.value = value;
  };
  const send = async () => {
    els['form-reco']!.listeners.submit!({ preventDefault: () => {} });
    await settle();
  };
  const posted = () => calls.filter((c) => c.method === 'POST' && c.url === POST);
  return { els, calls, fill, send, posted, storage, context, storageEvent: (key: string | null) => onStorage({ key }), state: () => els['reco-etat']!.textContent };
}

describe('X24 · le partenaire recommande une personne depuis son espace', () => {
  it('[R201] la page tient son budget, et chaque liste suit ce que le socle accepte', () => {
    expect(budgetProblems({ html: HTML, css: PARTNER_SPACE_FILES['/partenaire/partenaire.css']!, js: JS }, BUDGETS.page)).toEqual([]);
    for (const v of [...PROJECT_KINDS, ...RECOMMENDATION_CONSENT_KINDS, ...RECOMMENDATION_CONSENT_CHANNELS]) expect(HTML).toContain(`<option value="${v}">`);
    expect(JS).not.toContain('innerHTML');
  });

  it('[R142] la recommandation part avec la preuve de l’accord, dans la forme du socle, et les envois sont relus', async () => {
    const t = await run([ok({ recorded: true })], [ok([]), ok([{ createdAt: '2027-03-04T10:00:00.000Z' }])]);
    t.fill({ 'reco-prenom': ' Nina ', 'reco-tel': '06 00 00 00 00' });
    await t.send();
    const body = t.posted()[0]!.body!;
    expect(body).toEqual({
      projectKind: 'buy',
      firstName: 'Nina',
      email: 'nina@example.test',
      phone: '06 00 00 00 00',
      consent: { kind: 'message_ecrit', channel: 'email', givenAt: '2020-05-04T12:00:00.000Z', reference: 'courriel du 4 mai' },
    });
    for (const k of Object.keys(body)) expect(PARTNER_RECOMMENDATION_FIELDS as readonly string[]).toContain(k);
    for (const k of Object.keys(body.consent)) expect(RECOMMENDATION_CONSENT_FIELDS as readonly string[]).toContain(k);
    expect(t.state()).toBe('Recommandation transmise. Merci.');
    expect(t.els['reco-mail']!.value).toBe('');
    expect(t.els.envois!.children).toHaveLength(1);
    expect(t.els.envois!.children[0]!.textContent).toMatch(/^Envoyée le /);
  });

  it('[R03] un accord donné aujourd’hui n’est jamais daté dans le futur', async () => {
    const t = await run([ok({ recorded: true })]);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    t.fill({ 'reco-jour': today });
    await t.send();
    expect(t.posted()[0]!.body!.consent.givenAt).toBe(new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString());
  });

  it('[R03] un appareil qui avance d’une heure n’envoie pas un accord dans le futur', async () => {
    const real = Date;
    const ahead = 3_600_000;
    class Ahead extends real {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(real.now() + ahead);
        else super(...(args as [number, number, number]));
      }
    }
    const t = await run([ok({ recorded: true })], [ok([])], { Date: Ahead as unknown as DateConstructor });
    const d = new Ahead();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    t.fill({ 'reco-jour': today });
    await t.send();
    expect(Date.parse(t.posted()[0]!.body!.consent.givenAt)).toBeLessThanOrEqual(real.now() + ahead);
    expect(t.posted()[0]!.body!.consent.givenAt).toBe(new real(d.getFullYear(), d.getMonth(), d.getDate()).toISOString());
  });

  it('[R142] sans preuve, sans date, sans projet ou sans coordonnée, rien ne part', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ 'reco-mail': '' }, 'Donnez son mail ou son téléphone.'],
      [{ 'reco-projet': '' }, 'Choisissez son projet.'],
      [{ 'reco-preuve': '' }, 'Dites comment elle a donné son accord.'],
      [{ 'reco-canal': '' }, 'Dites comment elle accepte d’être contactée.'],
      [{ 'reco-jour': '' }, 'Dites quand elle a donné son accord.'],
      [{ 'reco-reference': ' ' }, 'Dites où retrouver la preuve, en 200 caractères au plus.'],
    ];
    for (const [over, text] of cases) {
      const t = await run();
      t.fill(over);
      await t.send();
      expect(t.state()).toBe(text);
      expect(t.posted()).toHaveLength(0);
    }
  });

  it('[R16] [R77] la liste des envois ne dit que la date, et le succès est le même texte quoi qu’il advienne', async () => {
    const t = await run([], [ok([{ createdAt: '2027-03-04T10:00:00.000Z', status: 'refusee', firstName: 'Nina' }])]);
    await settle();
    const text = t.els.envois!.all().map((e) => e.textContent).join(' ');
    expect(text).not.toContain('Nina');
    expect(text).not.toContain('refusee');
    expect(JS).not.toMatch(/item\.(status|firstName|state)\b.*envois/);
  });

  it('un refus du socle est dit en clair, la saisie reste', async () => {
    const t = await run([no(409, 'consent_too_old', 'R142'), no(409, 'reward', 'R66'), no(409, 'consent_channel_without_contact', 'R142'), no(403, 'credentials', 'R16'), no(400, 'inconnu')]);
    t.fill();
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      await t.send();
      lines.push(t.state());
    }
    expect(lines).toEqual([
      'Cet accord date de plus de 30 jours : redemandez-le-lui.',
      'Une recommandation ne se récompense jamais : retirez ce qui en parle.',
      'Donnez la coordonnée du canal qu’elle a accepté.',
      'Un de vos justificatifs n’est plus valable ce jour : envoyez sa nouvelle version à l’agence.',
      'Cette recommandation n’est pas transmise.',
    ]);
    expect(t.els['reco-mail']!.value).toBe('nina@example.test');
  });

  it('[R10] une réponse perdue ou une panne est dite telle, et la saisie reste pour la renvoyer', async () => {
    const t = await run([offline, no(500, 'internal'), ok({ recorded: true })], [ok([]), ok([{ createdAt: '2027-03-04T10:00:00.000Z' }])]);
    t.fill();
    await t.send();
    expect(t.state()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
    expect(t.state()).toContain('une date de plus s’affichera');
    // La liste est relue : un envoi bien arrivé s'y voit.
    expect(t.els.envois!.children).toHaveLength(1);
    expect(t.els['reco-mail']!.value).toBe('nina@example.test');
    await t.send();
    expect(t.state()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
    await t.send();
    expect(t.state()).toBe('Recommandation transmise. Merci.');
  });

  it('un double appui n’envoie qu’une fois', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run([() => new Promise<Response>((r) => { release = r; })]);
    t.fill();
    await t.send();
    await t.send();
    expect(t.posted()).toHaveLength(1);
    release(Response.json({ ok: true, data: { recorded: true } }));
    await settle();
    expect(t.state()).toBe('Recommandation transmise. Merci.');
  });

  it('[R16] la déconnexion vide le formulaire et les envois ; une réponse tardive n’écrit rien', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run([() => new Promise<Response>((r) => { release = r; })], [ok([{ createdAt: '2027-03-04T10:00:00.000Z' }])]);
    t.fill();
    await t.send();
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.els['reco-mail']!.value).toBe('');
    expect(t.els.envois!.children).toHaveLength(0);
    release(Response.json({ ok: true, data: { recorded: true } }));
    await settle();
    expect(t.state()).toBe('');
    expect(t.els.envois!.children).toHaveLength(0);
  });

  it('[R13] une clé refusée vide le formulaire et les envois, et libère l’envoi pour la clé suivante', async () => {
    const t = await run([no(401, 'bad_key'), ok({ recorded: true })], [ok([{ createdAt: '2027-03-04T10:00:00.000Z' }])]);
    t.fill();
    await t.send();
    expect(t.els['reco-mail']!.value).toBe('');
    expect(t.els.envois!.children).toHaveLength(0);
    expect(t.state()).toBe('');
    expect(t.els.entree!.hidden).toBe(false);
    t.els.cle!.value = 'n'.repeat(40);
    t.els['form-cle']!.listeners.submit!({ preventDefault: () => {} });
    await settle();
    t.fill();
    await t.send();
    expect(t.state()).toBe('Recommandation transmise. Merci.');
  });

  it('[R13] une clé retirée dans un autre onglet vide la page, tout de suite ou au geste suivant ; une nouvelle clé trouve une page vide', async () => {
    const t = await run([], [ok([{ createdAt: '2027-03-04T10:00:00.000Z' }])]);
    t.fill();
    t.storage.delete('aimmo.partenaire.cle');
    t.storageEvent('aimmo.partenaire.cle');
    expect(t.els['reco-mail']!.value).toBe('');
    expect(t.els.entree!.hidden).toBe(false);
    const geste = await run();
    geste.fill();
    geste.storage.delete('aimmo.partenaire.cle');
    await geste.send();
    expect(geste.els['reco-mail']!.value).toBe('');
    expect(geste.state()).toBe('');
    expect(geste.posted()).toHaveLength(0);
    const nouvelle = await run();
    nouvelle.fill();
    nouvelle.els.cle!.value = 'n'.repeat(40);
    nouvelle.els['form-cle']!.listeners.submit!({ preventDefault: () => {} });
    expect(nouvelle.els['reco-mail']!.value).toBe('');
  });

  it('les envois illisibles sont dits, sans bloquer le reste', async () => {
    const t = await run([], [offline]);
    expect(t.els['envois-etat']!.textContent).toBe('Vos envois ne se lisent pas pour le moment.');
    const refus = await run([], [no(403, 'role', 'R16')]);
    expect(refus.els['envois-etat']!.textContent).toBe('Votre espace ne permet pas de recommander.');
  });
});

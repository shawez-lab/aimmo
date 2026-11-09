import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, communes, campagnes, montants et clés inventés. Le mardi 9 mars 2027, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br03-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br03-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br03-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const TARGET = { communes: ['21231', '21166'], rayonKm: 20 };
const BUDGET = { dailyBudgetCents: 2_000, totalBudgetCents: 30_000, maxCostPerContactCents: 1_500 };
const CAMPAGNE = { platform: 'meta', name: 'Vendeurs Dijon', targeting: TARGET };

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const raw = async (who: Who, method: string, path: string, body?: unknown, text?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || text !== undefined) headers['content-type'] = 'application/json';
    const payload = text ?? (body === undefined ? undefined : JSON.stringify(body));
    return handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
  };
  const http = async (who: Who, method: string, path: string, body?: unknown) => {
    const r = await raw(who, method, path, body);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; detail?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
  return { ...t, raw, http, refusals, count };
}

describeWithSqlite('BR03 · routes du marketing : calendrier, lettre, publicité payante', () => {
  it('[R16] chaque route refuse le mauvais rôle, avant le corps : 403 et refus au journal', async () => {
    const t = await setup();
    const routes: [Who[], string, string, unknown?][] = [
      [['direction', 'conformite'], 'GET', '/marketing/calendrier/reglages'],
      [['direction', 'conformite'], 'POST', '/marketing/calendrier/reglages', { perDay: { instagram: 1 }, hours: ['09:00'] }],
      [['direction', 'conformite'], 'POST', '/marketing/calendrier/semaine', { from: '2027-03-10' }],
      [['direction', 'conformite'], 'GET', '/marketing/calendrier/creneaux?du=2027-03-10&au=2027-03-16'],
      [['alex', 'conformite'], 'POST', '/marketing/lettre/editions', { title: 'Lettre de printemps' }],
      // Un corps illisible ne passe jamais avant le rôle : le refus est écrit quand même.
      [['alex', 'conformite'], 'POST', '/marketing/lettre/editions', 'pas un objet'],
      [['conformite'], 'GET', '/marketing/magazine'],
      [['alex', 'conformite'], 'GET', '/marketing/publicite/campagnes'],
      [['conformite'], 'POST', '/marketing/publicite/campagnes', CAMPAGNE],
      [['alex', 'conformite'], 'POST', '/marketing/publicite/campagnes/c-1/validation', BUDGET],
      [['alex', 'conformite'], 'POST', '/marketing/publicite/campagnes/c-1/lancement'],
      [['alex', 'conformite'], 'POST', '/marketing/publicite/campagnes/c-1/arret'],
    ];
    for (const [whos, method, path, body] of routes) {
      for (const who of whos) {
        const before = (await t.refusals()).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.refusals()).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
    }
    expect(await t.count('social_calendar_rules')).toBe(0);
    expect(await t.count('newsletter_editions')).toBe(0);
    expect(await t.count('ad_campaigns')).toBe(0);
  });

  it('[R581] le calendrier réglé par la route : 0 à 3 par réseau, valable le lendemain, une version de plus à chaque réglage', async () => {
    const t = await setup();
    expect(await t.http('alex', 'POST', '/marketing/calendrier/reglages', { perDay: { instagram: 2 }, hours: ['09:00'] })).toMatchObject({ status: 409, body: { rule: 'R581', code: 'nombres_invalides' } });
    expect(await t.http('alex', 'POST', '/marketing/calendrier/reglages', { perDay: { myspace: 1 }, hours: ['09:00'] })).toMatchObject({ status: 409, body: { rule: 'R581', code: 'reseau_inconnu' } });
    expect(await t.http('alex', 'POST', '/marketing/calendrier/reglages', { perDay: { instagram: 1 }, hours: ['09:00'], agent: 'x' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.count('social_calendar_rules')).toBe(0);
    const set = await t.http('alex', 'POST', '/marketing/calendrier/reglages', { perDay: { instagram: 2, facebook: 1 }, hours: ['09:00', '18:00'] });
    expect(set).toMatchObject({ status: 200, body: { ok: true, mode: 'essai', data: { version: 1, effectiveDay: '2027-03-10', perDay: { instagram: 2, facebook: 1, linkedin: 0 } } } });
    // Rien ne vaut le jour même.
    expect((await t.http('alex', 'GET', '/marketing/calendrier/reglages')).body.data).toMatchObject({ today: null, next: { version: 1 } });
    expect((await t.http('alex', 'POST', '/marketing/calendrier/reglages', { perDay: { instagram: 1 }, hours: ['12:00'] })).body.data).toMatchObject({ version: 2 });
  });

  it('[R580] [R582] [R26] la semaine réservée par la route : sans publication prête ni lien marqué, aucun créneau ; rien ne part', async () => {
    const t = await setup();
    await t.http('alex', 'POST', '/marketing/calendrier/reglages', { perDay: { instagram: 1 }, hours: ['09:00'] });
    expect(await t.http('alex', 'POST', '/marketing/calendrier/semaine', { from: '2027-03-09' })).toMatchObject({ status: 200, body: { ok: true, data: [] } });
    expect(await t.http('alex', 'POST', '/marketing/calendrier/semaine', { from: '2027-03-08' })).toMatchObject({ status: 409, body: { rule: 'R10', code: 'jour_hors_calendrier' } });
    expect(await t.http('alex', 'POST', '/marketing/calendrier/semaine', { from: 'demain' })).toMatchObject({ status: 409, body: { rule: 'R10', code: 'jour_invalide' } });
    expect(await t.http('alex', 'GET', '/marketing/calendrier/creneaux?du=2027-03-10&au=2027-03-16')).toMatchObject({ status: 200, body: { data: [] } });
    expect(await t.http('alex', 'GET', '/marketing/calendrier/creneaux?du=2027-03-16&au=2027-03-10')).toMatchObject({ status: 409, body: { rule: 'R10', code: 'periode_invalide' } });
    expect(await t.count('social_calendar_slots')).toBe(0);
    // Aucune route ne passe les créneaux : aucun essai de publication.
    expect(await t.count('social_post_attempts')).toBe(0);
    expect((await t.http('alex', 'POST', '/marketing/calendrier/passage', {})).status).toBe(404);
  });

  it('[R583] [R584] [R586] la lettre : la direction ouvre une édition, titre sans chiffre ; aucune route n’envoie', async () => {
    const t = await setup();
    expect(await t.http('direction', 'POST', '/marketing/lettre/editions', { title: 'Les 5 biens du mois' })).toMatchObject({ status: 409, body: { rule: 'R586', code: 'titre' } });
    expect(await t.http('direction', 'POST', '/marketing/lettre/editions', { title: 'Lettre', texte: 'x' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    const big = await t.raw('direction', 'POST', '/marketing/lettre/editions', undefined, JSON.stringify({ title: 'x'.repeat(9_000) }));
    expect(big.status).toBe(400);
    expect(await t.count('newsletter_editions')).toBe(0);
    const ok = await t.http('direction', 'POST', '/marketing/lettre/editions', { title: 'Lettre de printemps' });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    const id = ok.body.data.id as string;
    expect((await t.http('direction', 'POST', `/marketing/lettre/editions/${id}/envoi`, {})).status).toBe(404);
    expect(await t.count('newsletter_letters')).toBe(0);
    expect(await t.count('newsletter_unsubscribe_tokens')).toBe(0);
  });

  it('[R585] le magazine tiré par l’agent ou la direction : une page imprimable, fermée, au titre écrit par le code', async () => {
    const t = await setup();
    for (const who of ['alex', 'direction'] as Who[]) {
      const r = await t.raw(who, 'GET', '/marketing/magazine');
      expect(r.status, who).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
      const page = await r.text();
      expect(page).toContain('Nos biens et les prix de nos quartiers');
      expect(page).not.toMatch(/<script/i);
    }
  });

  it('[R587] aucune dépense sans validation de la direction : l’agent propose, la direction valide et lance, en essai seulement', async () => {
    const t = await setup();
    const c = await t.http('alex', 'POST', '/marketing/publicite/campagnes', CAMPAGNE);
    expect(c).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    const id = c.body.data.id as string;
    expect(await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/lancement`)).toMatchObject({ status: 409, body: { rule: 'R587', code: 'sans_validation' } });
    expect(await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/validation`, { ...BUDGET, totalBudgetCents: 100 })).toMatchObject({ status: 409, body: { rule: 'R587', code: 'bad_budget' } });
    expect(await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/validation`, { ...BUDGET, spendCents: 0 })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.count('ad_campaign_starts')).toBe(0);
    expect((await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/validation`, BUDGET)).body.data).toMatchObject({ version: 1 });
    expect(await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/lancement`)).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    expect(await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/lancement`)).toMatchObject({ status: 409, body: { rule: 'R587', code: 'deja_lancee_ou_arretee' } });
    expect(await t.count('ad_campaign_starts')).toBe(1);
    expect((await t.http('direction', 'GET', '/marketing/publicite/campagnes')).body.data).toEqual([expect.objectContaining({ id, state: 'en_cours', spendCents: 0, contacts: 0, mandates: 0, sales: 0 })]);
    expect(await t.http('direction', 'POST', `/marketing/publicite/campagnes/${id}/arret`)).toMatchObject({ status: 200 });
    expect((await t.http('direction', 'GET', '/marketing/publicite/campagnes')).body.data[0]).toMatchObject({ state: 'arretee', stopReason: 'direction' });
    expect((await t.http('direction', 'POST', '/marketing/publicite/campagnes/inconnue/lancement')).status).toBe(404);
  });

  it('[R588] la dépense et les contacts ne se saisissent par aucune route : seul le travail planifié les lit chez la plateforme', async () => {
    const t = await setup();
    const id = (await t.http('direction', 'POST', '/marketing/publicite/campagnes', CAMPAGNE)).body.data.id as string;
    for (const path of [`/marketing/publicite/campagnes/${id}/depense`, `/marketing/publicite/campagnes/${id}/contacts`, '/marketing/publicite/controle']) {
      expect((await t.http('direction', 'POST', path, { day: '2027-03-09', amountCents: 1 })).status, path).toBe(404);
    }
    expect(await t.count('ad_campaign_spend')).toBe(0);
  });

  it('[R589] aucun ciblage par un critère interdit pour le logement : le critère est nommé, rien n’est rangé', async () => {
    const t = await setup();
    const age = await t.http('direction', 'POST', '/marketing/publicite/campagnes', { ...CAMPAGNE, targeting: { ...TARGET, age: [25, 45] } });
    expect(age).toMatchObject({ status: 409, body: { ok: false, rule: 'R589', code: 'critere_interdit', detail: 'age' } });
    expect(await t.http('alex', 'POST', '/marketing/publicite/campagnes', { ...CAMPAGNE, targeting: { communes: ['21231'], rayonKm: 5 } })).toMatchObject({ status: 409, body: { rule: 'R589', code: 'rayon' } });
    expect(await t.http('alex', 'POST', '/marketing/publicite/campagnes', { ...CAMPAGNE, audience: 'semblable' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.count('ad_campaigns')).toBe(0);
    expect((await t.journal.all()).filter((e) => e.type === 'publicite.refus')).toHaveLength(2);
  });
});

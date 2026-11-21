import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { adsFromEnv, runAdsPass, type AdsEnv } from '../src/publicite-reelle.ts';
import { AD_FAILURE_ACTIONS, trialAdPlatform, type AdPlatform } from '../../core/src/marketing/index.ts';
import { PUBLICITE_FAILURES, PUBLICITE_MODES, PUBLICITE_STEPS } from '../app/publicite.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// AU038 · réglages, comptes, jetons, lieux et montants inventés.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const none = (() => Promise.reject(new Error('aucun appel attendu'))) as unknown as typeof fetch;
const BASE: AdsEnv = {
  ADS_MODE: 'reel',
  ADS_PLAFOND_CENTS: '50000',
  ADS_LANDING_URL: 'https://reseau.example/estimer',
  ADS_LIEUX: JSON.stringify({ '21231': { google: '1006094', meta: '777' } }),
};
const META: AdsEnv = { META_ADS_TOKEN: 'jeton-meta-essai', META_ADS_ACCOUNT_ID: 'act_987654321', META_PAGE_ID: '111222333', META_ADS_TEXTE: 'Votre bien estimé par un conseiller du réseau.' };
const GOOGLE: AdsEnv = {
  GOOGLE_ADS_CLIENT_ID: 'abc.apps.googleusercontent.com',
  GOOGLE_ADS_CLIENT_SECRET: 'secret-essai',
  GOOGLE_ADS_REFRESH_TOKEN: 'rafraichir-essai',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-essai',
  GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
  GOOGLE_ADS_MOTS: 'estimation maison dijon',
  GOOGLE_ADS_TITRES: 'Estimer votre bien|Vendre à Dijon|Un conseiller local',
  GOOGLE_ADS_TEXTES: 'Un conseiller du réseau vous répond.|Prenez rendez-vous en ligne.',
};

it('[R587] le réel seulement quand tout est rangé (H63), plateforme par plateforme, avec son plafond ; sinon l’essai', () => {
  const modes = (env: AdsEnv) => {
    const a = adsFromEnv(env, none);
    return [a.platforms.google_ads.mode, a.platforms.meta.mode, a.realCapCents];
  };
  expect(modes({})).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...META, ...GOOGLE, ADS_MODE: 'oui' })).toEqual(['essai', 'essai', undefined]);
  // Sans plafond, ou hors de 1 € à 10 000 €, rien de réel.
  expect(modes({ ...BASE, ...META, ADS_PLAFOND_CENTS: undefined })).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...META, ADS_PLAFOND_CENTS: '2000000' })).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...META, ADS_LIEUX: '{pas du json' })).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...META, ADS_LANDING_URL: 'http://reseau.example/' })).toEqual(['essai', 'essai', undefined]);
  // Meta seul : Google reste d'essai, le plafond suit.
  expect(modes({ ...BASE, ...META })).toEqual(['essai', 'reel', 50_000]);
  expect(modes({ ...BASE, ...META, META_ADS_TEXTE: 'court' })).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...GOOGLE })).toEqual(['reel', 'essai', 50_000]);
  expect(modes({ ...BASE, ...GOOGLE, GOOGLE_ADS_CLIENT_ID: 'pas-un-client' })).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...GOOGLE, GOOGLE_ADS_DEVELOPER_TOKEN: ' ' })).toEqual(['essai', 'essai', undefined]);
  expect(modes({ ...BASE, ...META, ...GOOGLE })).toEqual(['reel', 'reel', 50_000]);
});

it('[R16] chaque échec, chaque mode et chaque étape ont leurs mots à l’écran, jamais leur code', () => {
  for (const code of Object.keys(AD_FAILURE_ACTIONS)) expect(PUBLICITE_FAILURES[code], code).toBeTruthy();
  for (const mode of ['essai', 'reel']) expect(PUBLICITE_MODES[mode]).toBeTruthy();
  for (const step of ['lancement', 'pause', 'depense']) expect(PUBLICITE_STEPS[step]).toBeTruthy();
});

describeWithSqlite('AU038 · la campagne réelle par les routes et le passage planifié', () => {
  it('[R587] [R588] la route valide sous le plafond, lance sur la plateforme réelle, et le passage lit sa dépense', async () => {
    const t = await setupAnnonce();
    t.setClock(NOW);
    const key = 'test-cle-au038-direction-ccccccccccccccccccccc';
    const apiKeys = JSON.stringify([{ sha256: await sha256Hex(key), networkId: t.network.id, role: 'direction', userId: t.direction.userId }]);
    const started: string[] = [];
    let spent = 0;
    const meta: AdPlatform = {
      mode: 'reel',
      start: async (l) => {
        started.push(l.code);
        return { externalRef: '4242' };
      },
      pause: async () => undefined,
      spend: async () => spent,
    };
    const ads = { platforms: { google_ads: trialAdPlatform(), meta }, realCapCents: 40_000 };
    const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, ads };
    const http = async (method: string, path: string, body?: unknown) => {
      const r = await handleRequest(
        new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        config,
      );
      return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string } };
    };
    const c = await http('POST', '/marketing/publicite/campagnes', { platform: 'meta', name: 'Vendeurs Dijon', targeting: { communes: ['21231'], rayonKm: 30 } });
    const id = c.body.data.id as string;
    expect(await http('POST', `/marketing/publicite/campagnes/${id}/validation`, { dailyBudgetCents: 2_000, totalBudgetCents: 40_001, maxCostPerContactCents: 1_500 })).toMatchObject({ body: { ok: false, code: 'plafond' } });
    expect((await http('POST', `/marketing/publicite/campagnes/${id}/validation`, { dailyBudgetCents: 2_000, totalBudgetCents: 40_000, maxCostPerContactCents: 1_500 })).body.ok).toBe(true);
    expect((await http('POST', `/marketing/publicite/campagnes/${id}/lancement`)).body.ok).toBe(true);
    expect(started).toHaveLength(1);
    spent = 600;
    await runAdsPass(t.db, t.journal, t.now, ads);
    expect((await http('GET', '/marketing/publicite/campagnes')).body.data[0]).toMatchObject({ state: 'en_cours', mode: 'reel', spendCents: 600, failure: null });
    // Le passage d'essai seul ne lit rien chez une plateforme réelle et ne casse rien.
    await runAdsPass(t.db, t.journal, t.now, adsFromEnv({}, none));
  });
});

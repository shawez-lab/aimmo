import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { checkRecruitingText } from '../../core/src/reseau/index.ts';
import { CANDIDATURE_PAGE_VERSION, PAGE_TEXT, candidaturePage, handleCandidature, pageProblems, pageTexts } from '../src/candidature.ts';
import { filledButtons } from '../../core/src/design/audit.ts';
import { DESIGN_CSS } from '../../core/src/design/systeme.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, candidats, coordonnées.
async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-07-12T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const network = await new FicheClient(db, { now }).createNetwork('Réseau test');
  const page = async (init: RequestInit & { path?: string } = {}, networkId: string | null = network.id) => {
    const res = await handleCandidature(new Request(`https://aimmo.exemple.test${init.path ?? '/rejoindre'}`, init), { db, networkId, now });
    return res === null ? null : { status: res.status, headers: res.headers, html: await res.text() };
  };
  const post = (fields: Record<string, string>, networkId: string | null = network.id) =>
    page({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }, networkId);
  return { db, journal, network, page, post };
}

const VALID = { firstName: 'Lina', email: 'lina@exemple.test', currentStatus: 'autre_metier', experience: 'aucune', source: 'page' };
/** Le texte visible d'une page, sans balise ni style. */
const visible = (html: string): string =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

it('[R80] chaque texte de la page de candidature passe le contrôle des promesses de revenus, un par un et ensemble', () => {
  expect(pageProblems()).toEqual([]);
  for (const text of pageTexts()) expect([text, checkRecruitingText(text).ok]).toEqual([text, true]);
  expect(checkRecruitingText(visible(candidaturePage())).ok).toBe(true);
});

it('[R80] la page ne parle ni de « mandataire », ni de « gratuit », ni de l’IA, et ne cite aucun montant', () => {
  const text = visible(candidaturePage());
  expect(text).not.toMatch(/mandataire/i);
  expect(text).not.toMatch(/gratuit/i);
  expect(text).not.toMatch(/\bIA\b|intelligence artificielle/i);
  expect(text).not.toMatch(/€|euros?\b/i);
  expect(text).toMatch(/agents? immobiliers?/i);
});

it('la page est accessible : chaque champ a son libellé, aucun script, faite pour le téléphone', () => {
  const html = candidaturePage();
  expect(html).not.toMatch(/<script/i);
  const ids = [...html.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThanOrEqual(10);
  for (const id of ids) expect([id, html.includes(`<label for="${id}"`) || html.includes(`for="${id}"`)]).toEqual([id, true]);
  // Le champ piège est caché aux lecteurs d'écran et hors du parcours au clavier.
  expect(html).toMatch(/class="piege" aria-hidden="true"/);
  expect(html).toMatch(/name="site" type="text" tabindex="-1"/);
  expect(html.match(/<h1>/g)).toHaveLength(1);
});

describeWithSqlite('J12 · page de candidature', () => {
  it('[R80] Jamais vu : un texte qui échouerait au contrôle ferme la page au lieu d’être publié, et c’est écrit au journal', async () => {
    const t = await setup();
    const res = await handleCandidature(new Request('https://aimmo.exemple.test/rejoindre'), { db: t.db, networkId: t.network.id, problems: () => ['Devenez riche en un an'] });
    expect(res!.status).toBe(503);
    const html = await res!.text();
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Devenez riche');
    expect((await t.journal.all()).map((e) => e.type)).toContain('candidature.page_fermee');
    // Les textes publiés ne se changent pas en cours de route.
    expect(Object.isFrozen(PAGE_TEXT.noPromise)).toBe(true);
  });

  it('DS074 · l’appel à candidater est un bouton, en haut, qui mène au formulaire ; le seul bouton plein est l’envoi', async () => {
    const body = candidaturePage();
    expect(body).toContain('<p><a class="appel second" href="#candidater">Déposer ma candidature</a></p>');
    // Avant la première partie de la page, et sa cible existe : le formulaire.
    expect(body.indexOf('href="#candidater"')).toBeLessThan(body.indexOf('<h2>'));
    expect(body).toContain('<h2 id="candidater">');
    expect(filledButtons(body)).toEqual(['Envoyer ma candidature']);
    // La page servie dessine ce bouton au trait, à la taille des boutons du système.
    const t = await setup();
    const served = (await t.page())!.html;
    expect(served).toContain('.second{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}');
    // Direction Maison : plus de losange penché sous les numéros des étapes, plus de petites capitales au-dessus des titres.
    const local = /<style>([\s\S]*?)<\/style>/.exec(served)![1]!.replace(DESIGN_CSS, '');
    expect(local).not.toMatch(/rotate\(|text-transform:\s*uppercase|--moutarde/);
    expect(local).toContain('ol.etapes li::before{content:counter(e);');
  });

  it('sert la page avec une politique de contenu fermée, et rien hors de son adresse', async () => {
    const t = await setup();
    const r = await t.page();
    expect(r!.status).toBe(200);
    expect(r!.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r!.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(r!.headers.get('cache-control')).toBe('no-store');
    expect(r!.html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(await t.page({ path: '/rejoindre-autre' })).toBeNull();
    expect((await t.page({ method: 'HEAD' }))!.html).toBe('');
    expect((await t.page({ method: 'PUT' }))!.status).toBe(405);
  });

  it('[R03] la candidature est rangée ; l’accord n’existe que si la case est cochée, avec la version de la page en preuve', async () => {
    const t = await setup();
    expect((await t.post({ ...VALID, consent: 'oui' }))!.status).toBe(200);
    expect((await t.post({ ...VALID, email: 'hugo@exemple.test', firstName: 'Hugo' }))!.status).toBe(200);
    const rows = await t.db.all<{ first_name: string; contact_consent_at: string | null; contact_consent_proof: string | null }>('SELECT first_name, contact_consent_at, contact_consent_proof FROM candidates ORDER BY created_at');
    expect(rows.map((r) => [r.first_name, r.contact_consent_at !== null])).toEqual([
      ['Lina', true],
      ['Hugo', false],
    ]);
    expect(rows[0]!.contact_consent_proof).toContain(`version ${CANDIDATURE_PAGE_VERSION}`);
    expect(rows[0]!.contact_consent_proof).not.toContain('lina@');
  });

  it('[R18] une deuxième candidature pour la même coordonnée reçoit la même réponse, sans rien ranger de plus', async () => {
    const t = await setup();
    const first = await t.post({ ...VALID, consent: 'oui' });
    const second = await t.post({ ...VALID, firstName: 'Autre', consent: 'oui' });
    expect(second!.status).toBe(first!.status);
    expect(second!.html).toBe(first!.html);
    expect(await t.db.all('SELECT id FROM candidates')).toHaveLength(1);
  });

  it('[R13] aucune coordonnée ni aucune question ne va au journal', async () => {
    const t = await setup();
    await t.post({ ...VALID, phone: '06 00 00 00 09', question: 'Ma question secrète', consent: 'oui' });
    const dump = JSON.stringify(await t.journal.all());
    for (const s of ['lina@exemple.test', 'Lina', '06 00 00 00 09', '600000009', 'Ma question secrète']) expect([s, dump.includes(s)]).toEqual([s, false]);
  });

  it('une erreur montre la page avec les valeurs saisies, échappées, et le champ à corriger', async () => {
    const t = await setup();
    const r = await t.post({ ...VALID, email: '', firstName: '<script>alert(1)</script>' });
    expect(r!.status).toBe(400);
    expect(r!.html).toContain('role="alert"');
    expect(r!.html).toContain('Laissez au moins une adresse mail ou un numéro de téléphone.');
    expect(r!.html).toMatch(/id="email"[^>]*aria-invalid="true"/);
    expect(r!.html).not.toContain('<script>alert(1)</script>');
    expect(r!.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(await t.db.all('SELECT id FROM candidates')).toEqual([]);
  });

  it('un robot qui remplit le champ piège reçoit la même réponse, et rien n’est rangé', async () => {
    const t = await setup();
    const human = await t.post({ ...VALID, email: 'humain@exemple.test' });
    const robot = await t.post({ ...VALID, email: 'robot@exemple.test', site: 'https://spam.exemple.test' });
    expect(robot!.status).toBe(200);
    expect(robot!.html).toBe(human!.html);
    expect(await t.db.all('SELECT email FROM candidates')).toEqual([{ email: 'humain@exemple.test' }]);
  });

  it('le parrain vient du lien, n’est gardé que s’il a la forme d’un identifiant, et la couche métier vérifie qu’il est actif', async () => {
    const t = await setup();
    const withSponsor = await t.page({ path: '/rejoindre?parrain=agent-42' });
    expect(withSponsor!.html).toContain('<input type="hidden" name="parrain" value="agent-42">');
    const injected = await t.page({ path: `/rejoindre?parrain=${encodeURIComponent('"><b>x</b>')}` });
    expect(injected!.html).not.toContain('name="parrain"');
    // Un parrain inconnu du réseau est ignoré, sans le dire.
    expect((await t.post({ ...VALID, parrain: 'agent-42' }))!.status).toBe(200);
    expect(await t.db.all('SELECT sponsor_agent_id FROM candidates')).toEqual([{ sponsor_agent_id: null }]);
  });

  it('[R81] AU022 : sans variable réglée et avec un seul réseau, la page sert le formulaire et la candidature arrive dans la file', async () => {
    const t = await setup();
    const g = await t.page({}, null);
    expect(g!.status).toBe(200);
    expect(g!.html).not.toMatch(/<h1>Bientôt<\/h1>/);
    expect(g!.html).toMatch(/<form[^>]+method="post"/i);
    expect(g!.html).toMatch(/name="consent"/);
    const r = await t.post({ ...VALID, consent: 'oui' }, null);
    expect(r!.status).toBe(200);
    const rows = await t.db.all<{ network_id: string }>('SELECT network_id FROM candidates');
    expect(rows).toEqual([{ network_id: t.network.id }]);
    const events = await t.db.all<{ type: string }>("SELECT type FROM journal WHERE type = 'candidature.reseau_unique'");
    expect(events.length).toBeGreaterThan(0);
  });

  it('AU022 : la variable réglée l’emporte sur le réseau unique', async () => {
    const t = await setup();
    const other = await new FicheClient(t.db, { now: () => new Date('2027-07-12T09:00:00.000Z') }).createNetwork('Autre réseau');
    expect((await t.post({ ...VALID }, other.id))!.status).toBe(200);
    expect(await t.db.all('SELECT network_id FROM candidates')).toEqual([{ network_id: other.id }]);
  });

  it('sans variable et avec plusieurs réseaux, la page ne devine pas : elle dit que les candidatures ne sont pas ouvertes et ne range rien', async () => {
    const t = await setup();
    await new FicheClient(t.db, { now: () => new Date('2027-07-12T09:00:00.000Z') }).createNetwork('Autre réseau');
    const r = await t.post({ ...VALID }, null);
    expect(r!.status).toBe(503);
    expect(await t.db.all('SELECT id FROM candidates')).toEqual([]);
  });

  it('sans aucun réseau, la page dit que les candidatures ne sont pas ouvertes', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const res = await handleCandidature(new Request('https://aimmo.exemple.test/rejoindre'), { db, networkId: null });
    expect(res!.status).toBe(503);
  });

  it('un formulaire illisible ou trop long est refusé sans rien ranger', async () => {
    const t = await setup();
    expect((await t.page({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(VALID) }))!.status).toBe(400);
    expect((await t.post({ ...VALID, question: 'x'.repeat(9_000) }))!.status).toBe(413);
    expect(await t.db.all('SELECT id FROM candidates')).toEqual([]);
  });
});

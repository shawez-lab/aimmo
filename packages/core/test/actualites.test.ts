import { describe, expect, it } from 'vitest';
import { Actualites, normaliseSourceUrl, parseTarget, type NewsInput } from '../src/actualites/actualites.ts';
import { FicheBien } from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Actualités, sources et biens inventés.
async function setup() {
  const t = await setupAnnonce();
  // Le 2027-02-12 à Paris : le mandat du bien REF-T-1 (classe D, en copropriété, 21000) est inscrit.
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  const actu = new Actualites(t.db, t.acces, t.journal, { now: t.now });
  const fiche = new FicheBien(t.db, t.acces, t.journal, { now: t.now });
  let k = 0;
  const base = (): NewsInput => ({
    topic: 'juridique',
    title: 'Nouvelle règle de test',
    impact: 'Prévenez vos vendeurs concernés avant la mise en vente.',
    sourceName: 'Journal officiel de test',
    sourceUrl: `https://exemple.test/textes/${++k}`,
    sourceDate: '2027-02-01',
  });
  const add = async (over: Partial<NewsInput> = {}) => {
    const r = await actu.publish(t.direction, { ...base(), ...over });
    if (!r.ok) throw new Error(r.code);
    return r.newsId;
  };
  /** Un bien de l'agent, en estimation (aucun mandat), avec sa classe énergie. */
  const property = async (reference: string, energyClass: string, postalCode = '21000', isCoownership = false) => {
    const b = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference, kind: 'home', postalCode, city: 'Dijon', surfaceM2: 80, rooms: 4, priceEur: 150000 });
    const s = await fiche.save(t.agent, b.id, {
      characteristics: { bedrooms: 3, floor: 0, floorsTotal: 1, buildYear: 1950, heating: 'fioul', outdoor: [], parkingSpaces: 0, elevator: false },
      energy: { energyClass, climateClass: energyClass, annualCostMinEur: 2000, annualCostMaxEur: 2800, costReferenceYear: 2023, diagnosedOn: '2027-01-20' },
      coownership: isCoownership ? { isCoownership: true, lots: 8, annualChargesEur: 900, proceedings: false } : { isCoownership: false },
      risks: { inRiskZone: false },
      media: [],
    });
    if (!s.ok) throw new Error(s.code + ('field' in s ? ' ' + String(s.field) : ''));
    return b.id;
  };
  const feed = async (viewer = t.agent) => {
    const r = await actu.feed(viewer);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, actu, add, base, property, feed };
}

describe('HX09 · adresse de la source', () => {
  it('[R268] une seule forme par source : sans suivi, sans ancre, sans barre finale ; https public seulement', () => {
    expect(normaliseSourceUrl('https://Exemple.test/a/?utm_source=x&b=2&fbclid=y#haut')).toBe('https://exemple.test/a?b=2');
    expect(normaliseSourceUrl('https://exemple.test/a/')).toBe('https://exemple.test/a');
    expect(normaliseSourceUrl('https://exemple.test/a')).toBe('https://exemple.test/a');
    expect(normaliseSourceUrl('https://exemple.test/a/?b=2')).toBe(normaliseSourceUrl('https://exemple.test/a?b=2'));
    expect(normaliseSourceUrl('https://exemple.test/')).toBe('https://exemple.test/');
    for (const bad of ['http://exemple.test/a', 'https://moi:secret@exemple.test/a', 'https://exemple.test:8443/a', 'https://192.168.0.1/a', 'https://localhost/a', 'ftp://exemple.test', 'exemple.test/a', 'https://exemple.test/a b', '', 42]) {
      expect(normaliseSourceUrl(bad)).toBeNull();
    }
  });

  it('[R269] une cible vient d’une liste fermée, sous une forme unique', () => {
    expect(parseTarget(undefined)).toEqual({});
    expect(parseTarget({ energyClasses: ['G', 'F', 'G'], postcodes: ['21000'] })).toEqual({ energyClasses: ['F', 'G'], postcodes: ['21000'] });
    for (const bad of [{ energyClasses: [] }, { energyClasses: ['H'] }, { postcodes: ['2100'] }, { moments: ['signature'] }, { kinds: ['chateau'] }, { coownership: false }, { owner: 'x' }, ['G'], 'G']) {
      expect(parseTarget(bad)).toBeNull();
    }
  });
});

describeWithSqlite('HX09 · actualités utiles', () => {
  it('[R268] la direction seule range une actualité, toujours avec sa source, sa date et sa ligne d’effet', async () => {
    const t = await setup();
    const b = t.base();
    expect(await t.actu.publish(t.agent, b)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.actu.publish(t.direction, { ...b, sourceName: ' ' })).toEqual({ ok: false, rule: 'R268', code: 'sans_source' });
    expect(await t.actu.publish(t.direction, { ...b, sourceUrl: undefined })).toEqual({ ok: false, rule: 'R268', code: 'sans_source' });
    expect(await t.actu.publish(t.direction, { ...b, sourceUrl: 'http://exemple.test/x' })).toEqual({ ok: false, rule: 'R268', code: 'bad_source_url' });
    expect(await t.actu.publish(t.direction, { ...b, sourceDate: undefined })).toEqual({ ok: false, rule: 'R268', code: 'bad_source_date' });
    expect(await t.actu.publish(t.direction, { ...b, sourceDate: '2027-02-30' })).toEqual({ ok: false, rule: 'R268', code: 'bad_source_date' });
    expect(await t.actu.publish(t.direction, { ...b, sourceDate: '2027-02-13' })).toEqual({ ok: false, rule: 'R268', code: 'source_a_venir' });
    expect(await t.actu.publish(t.direction, { ...b, impact: undefined })).toEqual({ ok: false, rule: 'R268', code: 'sans_effet' });
    expect(await t.actu.publish(t.direction, { ...b, impact: 'Première ligne utile.\nDeuxième ligne en trop.' })).toEqual({ ok: false, rule: 'R268', code: 'impact_une_ligne' });
    expect(await t.actu.publish(t.direction, { ...b, target: { energyClasses: ['H'] } })).toEqual({ ok: false, rule: 'R269', code: 'bad_target' });
    expect((await t.actu.publish(t.direction, b)).ok).toBe(true);
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse' AND data LIKE '%actualites%'");
    expect(refused.length).toBe(1);
    // La base refuse aussi une actualité sans adresse https ou sur deux lignes, et rien ne change ni ne s'efface.
    const row = ['x', t.network.id, 'juridique', 'Titre', 'Une ligne assez longue.', 'Source', 'https://exemple.test/y', '2027-02-01', '{}', '2027-02-12', 'd', 'n'];
    const sql = 'INSERT INTO network_news (id, network_id, topic, title, impact, source_name, source_url, source_date, target, published_on, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    await expect(t.db.run(sql, row.map((v, i) => (i === 6 ? 'http://exemple.test/y' : v)))).rejects.toThrow();
    await expect(t.db.run(sql, row.map((v, i) => (i === 4 ? 'Une ligne\nassez longue.' : v)))).rejects.toThrow();
    await expect(t.db.run('UPDATE network_news SET title = ?', ['Autre titre'])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM network_news')).rejects.toThrow();
  });

  it('[R268] chaque actualité montrée cite sa source : éditeur, adresse et date', async () => {
    const t = await setup();
    await t.add({ sourceUrl: 'https://exemple.test/textes/source-citee?utm_campaign=lettre' });
    const [item] = await t.feed();
    expect(item!.source).toEqual({ name: 'Journal officiel de test', url: 'https://exemple.test/textes/source-citee', date: '2027-02-01' });
    expect(item!.impact).toBe('Prévenez vos vendeurs concernés avant la mise en vente.');
  });

  it('[R269] la même source n’est jamais rangée deux fois, même avec des marqueurs de suivi', async () => {
    const t = await setup();
    await t.add({ sourceUrl: 'https://exemple.test/loi/1' });
    expect(await t.actu.publish(t.direction, { ...t.base(), sourceUrl: 'https://EXEMPLE.test/loi/1/?utm_source=lettre#art-2' })).toEqual({ ok: false, rule: 'R269', code: 'deja_rangee' });
    // Barre finale avec des paramètres : la même source aussi.
    await t.add({ sourceUrl: 'https://exemple.test/loi/2/?article=3' });
    expect(await t.actu.publish(t.direction, { ...t.base(), sourceUrl: 'https://exemple.test/loi/2?article=3' })).toEqual({ ok: false, rule: 'R269', code: 'deja_rangee' });
  });

  it('[R268] une longueur se compte en caractères, comme la base : jamais un refus pris pour un doublon', async () => {
    const t = await setup();
    expect(await t.actu.publish(t.direction, { ...t.base(), title: '🏠🏠' })).toEqual({ ok: false, rule: null, code: 'bad_title' });
    const id = await t.add({ title: '🏠🏠🏠🏠' });
    expect(await t.actu.withdraw(t.direction, id, '😀')).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await t.actu.withdraw(t.direction, id, '😀😀')).toEqual({ ok: true });
  });

  it('[R269] une actualité n’est montrée qu’une fois à un agent, jamais deux, même demandée deux fois en même temps', async () => {
    const t = await setup();
    const id = await t.add();
    const [a, b] = await Promise.all([t.actu.feed(t.agent), t.actu.feed(t.agent)]);
    if (!a.ok || !b.ok) throw new Error('feed');
    expect([...a.value, ...b.value].map((i) => i.id)).toEqual([id]);
    expect(await t.feed()).toEqual([]);
    // Un autre agent la voit, lui aussi une seule fois.
    expect((await t.feed(t.sam)).map((i) => i.id)).toEqual([id]);
    expect(await t.feed(t.sam)).toEqual([]);
    const shown = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM network_news_deliveries WHERE news_id = ?', [id]);
    expect(Number(shown!.n)).toBe(2);
  });

  it('[R269] [R16] jamais vu : chaque actualité dit quels dossiers de l’agent elle touche, et pourquoi, lu dans la base', async () => {
    const t = await setup();
    const g = await t.property('REF-G-1', 'G');
    await t.property('REF-C-1', 'C');
    const f = await t.property('REF-F-2', 'F', '21000', true);
    await t.property('REF-F-3', 'F', '71000');
    const id = await t.add({ target: { energyClasses: ['F', 'G'], postcodes: ['21000'] } });
    const readsOf = async () => (await t.db.all<{ subject: string }>("SELECT subject FROM journal WHERE type = 'bien.lu' ORDER BY rowid")).map((r) => r.subject);
    const before = (await readsOf()).length;
    const [item] = await t.feed();
    expect(item!.id).toBe(id);
    expect(item!.concerned).toEqual([
      { propertyId: f, reference: 'REF-F-2', why: 'Classe énergie F, 21000.' },
      { propertyId: g, reference: 'REF-G-1', why: 'Classe énergie G, 21000.' },
    ]);
    // Chaque dossier montré est lu par le chemin des droits, et sa lecture est au journal [R16].
    expect((await readsOf()).slice(before).sort()).toEqual([`property:${f}`, `property:${g}`].sort());
    // Le moment et la copropriété, lus aussi dans la base : le mandat du bien REF-T-1 est inscrit, son lot en copropriété.
    const m = await t.add({ target: { moments: ['mandat'], coownership: true } });
    const [mi] = await t.feed();
    expect(mi!.id).toBe(m);
    expect(mi!.concerned).toEqual([{ propertyId: t.propertyId, reference: 'REF-T-1', why: 'En copropriété, mandat inscrit.' }]);
  });

  it('[R269] pas du bruit : une actualité ciblée qui ne touche aucun de ses dossiers ne lui est pas montrée', async () => {
    const t = await setup();
    await t.property('REF-G-1', 'G');
    const fg = await t.add({ target: { energyClasses: ['G'] } });
    const whole = await t.add({ topic: 'marche', title: 'Taux de crédit de test' });
    // Sam n'a aucun bien classé G : il ne voit que l'actualité de tout le réseau, sans dossier.
    const sam = await t.feed(t.sam);
    expect(sam.map((i) => [i.id, i.concerned.length])).toEqual([[whole, 0]]);
    // Alex voit d'abord celle qui touche son dossier.
    expect((await t.feed()).map((i) => i.id)).toEqual([fg, whole]);
    // Le bien d'un autre agent n'est jamais montré comme dossier concerné.
    await t.store.createProperty({ networkId: t.network.id, agentId: t.sam.userId, reference: 'REF-S-1', kind: 'land', postalCode: '21000', city: 'Dijon', surfaceM2: 500, rooms: 0, priceEur: 50000 });
    await t.add({ target: { kinds: ['land'] } });
    const samLand = await t.feed(t.sam);
    expect(samLand.map((i) => i.concerned.map((c) => c.reference))).toEqual([['REF-S-1']]);
    expect(await t.feed()).toEqual([]);
  });

  it('[R269] ni retirée, ni publiée depuis plus de 60 jours : elle n’est plus montrée', async () => {
    const t = await setup();
    const old = await t.add();
    const gone = await t.add();
    expect(await t.actu.withdraw(t.agent, gone, 'Texte abrogé')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.actu.withdraw(t.direction, gone, 'Texte abrogé')).toEqual({ ok: true });
    expect(await t.actu.withdraw(t.direction, gone, 'Texte abrogé')).toEqual({ ok: false, rule: null, code: 'deja_retiree' });
    // Le 14 avril 2027 à Paris : publiée le 12 février, plus de 60 jours.
    t.setClock(new Date('2027-04-14T10:00:00.000Z'));
    expect(await t.feed()).toEqual([]);
    t.setClock(new Date('2027-04-13T10:00:00.000Z'));
    expect((await t.feed()).map((i) => i.id)).toEqual([old]);
    const cat = await t.actu.catalogue(t.direction);
    if (!cat.ok) throw new Error(cat.code);
    expect(cat.value.find((c) => c.id === gone)!.withdrawn).toBe(true);
  });

  it('[R269] retirée pendant que le fil se prépare : elle n’est pas montrée', async () => {
    const t = await setup();
    const id = await t.add();
    // Le retrait arrive pendant la lecture des dossiers de l'agent, entre la liste et la réservation.
    const db = new Proxy(t.db, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (key !== 'all') return typeof v === 'function' ? v.bind(target) : v;
        return async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM properties p')) await t.actu.withdraw(t.direction, id, 'Texte abrogé');
          return target.all(sql, params as never);
        };
      },
    });
    const racing = new Actualites(db, t.acces, t.journal, { now: t.now });
    const r = await racing.feed(t.agent);
    expect(r).toEqual({ ok: true, value: [] });
    const shown = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM network_news_deliveries');
    expect(Number(shown!.n)).toBe(0);
  });

  it('[R86] le jour de son départ, dès minuit à Paris, l’agent n’a plus de fil, même avant le passage', async () => {
    const t = await setup();
    await t.add();
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, '2027-01-12', '2027-02-13', 'demission_agent', 1, 'direction:direction-1', '2027-01-12T10:00:00.000Z')",
      [t.network.id, t.alexId],
    );
    // Le 13 février à 0 h 30 à Paris : statut encore « active », mais parti.
    t.setClock(new Date('2027-02-12T23:30:00.000Z'));
    expect(await t.actu.feed(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    const shown = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM network_news_deliveries');
    expect(Number(shown!.n)).toBe(0);
  });

  it('[R13] le journal ne garde que des identifiants et des nombres ; un agent inactif n’a pas de fil', async () => {
    const t = await setup();
    await t.property('REF-G-1', 'G');
    await t.add({ target: { energyClasses: ['G'] } });
    await t.feed();
    const rows = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'actualite.%'");
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.data).not.toMatch(/REF-G-1|exemple\.test|Prévenez|21000/);
    }
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await t.actu.feed(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.actu.feed(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });
});

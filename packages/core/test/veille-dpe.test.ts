import { expect, it } from 'vitest';
import { banDate, dayInFrench } from '../src/location/logement.ts';
import { checkLetterText } from '../src/mandats/gagner/lettres-quartier.ts';
import { addressCarriesPerson as scoreAddressCarriesPerson } from '../src/score-adresse/score.ts';
import { ADEME_FIELDS, AdemeDiagnosisFeed, addressCarriesPerson, VeilleDpe, checkOwnerLetter, dpeWatchJob, ownerLetterText, readDiagnosis, type DiagnosisFeed } from '../src/veille-dpe/veille.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, diagnostics et adresses inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const DAY = 24 * 3_600_000;

let seq = 0;
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    numero_dpe: `2621E${String(1_000_000 + seq)}T`,
    date_etablissement_dpe: '2026-12-01',
    date_reception_dpe: '2026-12-02',
    etiquette_dpe: 'G',
    etiquette_ges: 'F',
    type_batiment: 'appartement',
    surface_habitable_logement: 42.5,
    numero_voie_ban: '7',
    nom_rue_ban: 'Rue des Essais',
    code_postal_ban: '21240',
    nom_commune_ban: 'Talant',
    _geopoint: '47.33,5.01',
    ...over,
  };
}

/** Une source en mémoire : chaque code postal rend ses lignes ; les appels sont notés. */
function fakeFeed() {
  const byPostcode = new Map<string, Record<string, unknown>[]>();
  const calls: { postcode: string; since: string }[] = [];
  const feed: DiagnosisFeed = {
    recent: async (q) => {
      calls.push(q);
      return byPostcode.get(q.postcode) ?? [];
    },
  };
  return { feed, calls, set: (pc: string, rows: Record<string, unknown>[]) => byPostcode.set(pc, rows) };
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const source = fakeFeed();
  const veille = new VeilleDpe(db, source.feed, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = (agentId: string, commune: string, networkId = network.id) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), networkId, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(alex.id, 'Fontaine-lès-Dijon');
  await zone(sam.id, 'Dijon');
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string, networkId = network.id) => ({ role, userId, networkId });
  return { db, journal, veille, source, store, network, other, alex, sam, zone, as, agentAlex: as('agent', alex.id), agentSam: as('agent', sam.id), direction: as('direction', 'd1'), setClock: (t: number) => (clock = t), now };
}

it('[R288] une ligne de la source n’est lue que par sa liste fermée de champs : un nom en plus ne passe jamais', () => {
  const r = readDiagnosis(row({ nom_proprietaire: 'Jean Essai', telephone: '0600000000', email: 'jean@exemple.test' }), '21240');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(Object.keys(r.value).sort()).toEqual(['commune', 'diagnosedOn', 'energyClass', 'ghgClass', 'kind', 'lat', 'lon', 'number', 'postcode', 'receivedOn', 'street', 'streetNumber', 'surfaceM2'].sort());
  expect(JSON.stringify(r.value)).not.toMatch(/Jean|0600000000|exemple/);
  expect(r.value).toMatchObject({ kind: 'apartment', energyClass: 'G', ghgClass: 'F', street: 'Rue des Essais', streetNumber: '7', lat: 47.33, lon: 5.01, surfaceM2: 42.5 });
  // Ce qui est demandé à la source est la même liste fermée, sans aucun champ de personne.
  expect(ADEME_FIELDS.join(',')).not.toMatch(/nom_prop|proprietaire|telephone|mail|siren/);
});

it('[R288] une adresse qui porte une civilité ou un nom est écartée entière ; une ligne illisible aussi', () => {
  expect(readDiagnosis(row({ nom_rue_ban: 'Chez Martin Rue des Essais' }), '21240')).toEqual({ ok: false, code: 'nom_dans_adresse' });
  expect(readDiagnosis(row({ nom_rue_ban: 'M. Essai Rue des Essais' }), '21240')).toEqual({ ok: false, code: 'nom_dans_adresse' });
  expect(readDiagnosis(row({ nom_rue_ban: 'Famille Test Allée des Prés' }), '21240')).toEqual({ ok: false, code: 'nom_dans_adresse' });
  expect(readDiagnosis(row({ code_postal_ban: '21000' }), '21240')).toEqual({ ok: false, code: 'hors_code_postal' });
  for (const bad of [
    row({ numero_dpe: 'x' }),
    row({ etiquette_dpe: 'H' }),
    row({ date_reception_dpe: '2026-02-31' }),
    row({ date_etablissement_dpe: '2026-12-05', date_reception_dpe: '2026-12-02' }),
    row({ type_batiment: 'bureau' }),
    row({ nom_rue_ban: 'Rue\ndes Essais' }),
    row({ numero_voie_ban: 'douze' }),
    null,
    'texte',
  ]) expect(readDiagnosis(bad, '21240')).toEqual({ ok: false, code: 'illisible' });
  // Sans numéro de voie ni position : lisible, sans rien deviner.
  const r = readDiagnosis(row({ numero_voie_ban: null, _geopoint: 'nulle part', surface_habitable_logement: 'grand' }), '21240');
  expect(r).toMatchObject({ ok: true, value: { streetNumber: null, lat: null, lon: null, surfaceM2: null } });
});

it('[R288] une voie au titre d’une personne n’écarte plus le diagnostic ; toute autre marque de personne l’écarte toujours (RC04)', () => {
  for (const street of ['Rue du Docteur Chaussier', 'Place du Maréchal Leclerc', 'Avenue du Président Wilson', 'Boulevard Docteur Petitjean', 'Rue de la Sainte Chapelle']) {
    const r = readDiagnosis(row({ nom_rue_ban: street }), '21240');
    expect(r, street).toMatchObject({ ok: true, value: { street } });
  }
  for (const street of [
    'Docteur Chaussier',
    'Rue du Docteur Chaussier chez Martin',
    'Mme Essai Rue du Docteur Chaussier',
    'Famille Test Rue du Maréchal Leclerc',
    'Rue des Essais Monsieur Test',
    'Rue du Docteur Chaussier Docteur Essai',
  ]) expect(readDiagnosis(row({ nom_rue_ban: street }), '21240'), street).toEqual({ ok: false, code: 'nom_dans_adresse' });
  expect(readDiagnosis(row({ nom_commune_ban: 'Chez Martin' }), '21240')).toEqual({ ok: false, code: 'nom_dans_adresse' });
  // Le score par adresse lit la même fonction, sans rien changer [R292].
  expect(scoreAddressCarriesPerson).toBe(addressCarriesPerson);
  expect(addressCarriesPerson('12 rue du Docteur Chaussier, Dijon')).toBe(false);
  expect(addressCarriesPerson('M. Dupont 7 rue des Essais')).toBe(true);
});

it('[R288] un titre après un faubourg, un mail, une cité, une ruelle, un lieu-dit n’écarte plus le diagnostic (RC06)', () => {
  for (const street of ['Faubourg du Docteur Essai', 'Mail du Président Essai', 'Cité du Maréchal Essai', 'Ruelle du Docteur Essai', 'Lieu-dit Mademoiselle Essai', 'Venelle de la Mère Essai', 'Montée du Général Essai']) {
    expect(readDiagnosis(row({ nom_rue_ban: street }), '21240'), street).toMatchObject({ ok: true, value: { street } });
  }
  for (const street of ['Faubourg Mme Essai', 'Mail Mlle Essai', 'Cité Mr Essai', 'Faubourg du Docteur Essai chez Martin', 'Mail du Président Essai Docteur Martin', 'Mademoiselle Essai']) {
    expect(readDiagnosis(row({ nom_rue_ban: street }), '21240'), street).toEqual({ ok: false, code: 'nom_dans_adresse' });
  }
  expect(addressCarriesPerson('3 faubourg du Docteur Essai, Dijon')).toBe(false);
  expect(scoreAddressCarriesPerson('3 faubourg du Docteur Essai, Dijon')).toBe(false);
  expect(addressCarriesPerson('3 faubourg Mme Essai, Dijon')).toBe(true);
});

it('[R290] la lettre est écrite par le code : la classe, la date d’interdiction de M15, aucun autre chiffre, aucun nom', () => {
  const g = ownerLetterText('G', banDate('G')!, '2026-12-07');
  expect(g).toContain('classé G');
  expect(g).toContain(`Depuis le ${dayInFrench('2025-01-01')}`);
  expect(g).toContain('sans connaître votre nom');
  expect(checkOwnerLetter(g, '2025-01-01')).toBeNull();
  const f = ownerLetterText('F', banDate('F')!, '2026-12-07');
  expect(f).toContain(`À partir du ${dayInFrench('2028-01-01')}`);
  expect(f).toContain('D’ici là, un bail peut encore être signé');
  expect(checkOwnerLetter(f, '2028-01-01')).toBeNull();
  // Seule la date de M15 est un chiffre permis : un autre chiffre est refusé par le contrôle de G06.
  expect(checkOwnerLetter(`${f} Comptez 30 000 euros.`, '2028-01-01')).toBe('figure');
  expect(checkOwnerLetter(f, '2034-01-01')).toBe('sans_date');
  expect(checkLetterText(f, null)).toBe('figure');
  expect(f).not.toMatch(/mandataire|gratuit|\bIA\b/);
});

describeWithSqlite('HX16 · veille des nouveaux diagnostics énergétiques', () => {
  it('[R289] un secteur de veille est une commune des zones en cours de l’agent ; personne d’autre n’en ouvre', async () => {
    const t = await setup();
    expect(await t.veille.watch(t.agentAlex, { commune: 'talant', postcode: '21240' })).toMatchObject({ ok: true });
    expect(await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' })).toEqual({ ok: false, rule: 'R289', code: 'deja_suivi' });
    expect(await t.veille.watch(t.agentAlex, { commune: 'Dijon', postcode: '21000' })).toEqual({ ok: false, rule: 'R289', code: 'hors_zone' });
    expect(await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '2124' })).toEqual({ ok: false, rule: 'R289', code: 'bad_postcode' });
    expect(await t.veille.watch(t.direction, { commune: 'Talant', postcode: '21240' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.veille.watch(t.as('compliance', 'c1'), { commune: 'Talant', postcode: '21240' })).toMatchObject({ ok: false, rule: 'R16' });
    const s = await t.veille.sectors(t.agentAlex);
    expect(s).toMatchObject({ ok: true, sectors: [{ commune: 'Talant', postcode: '21240', inZone: true }] });
  });

  it('[R288] un diagnostic déjà vu ne remonte jamais deux fois, même relu le lendemain ou par un second passage', async () => {
    const t = await setup();
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    const a = row();
    const b = row({ etiquette_dpe: 'C' });
    t.source.set('21240', [a, b, { ...a }]);
    const first = await t.veille.run();
    expect(first).toMatchObject({ inserted: 2, alerted: 2 });
    expect(t.source.calls).toEqual([{ postcode: '21240', since: '2026-11-30' }]);
    // Même passage rejoué, puis le lendemain avec les mêmes lignes et une nouvelle.
    expect(await t.veille.run()).toMatchObject({ inserted: 0, alerted: 0 });
    t.setClock(MONDAY_9H + DAY);
    const c = row({ date_reception_dpe: '2026-12-08', date_etablissement_dpe: '2026-12-08' });
    t.source.set('21240', [a, b, c]);
    expect(await t.veille.run()).toMatchObject({ inserted: 1, alerted: 1 });
    const today = await t.veille.alerts(t.agentAlex);
    expect(today).toMatchObject({ ok: true });
    if (!today.ok) return;
    expect(today.alerts).toHaveLength(1);
    expect(today.alerts[0]!.items.map((i) => i.number)).toEqual([String(c['numero_dpe'])]);
    const yesterday = await t.veille.alerts(t.agentAlex, '2026-12-07');
    if (!yesterday.ok) throw new Error('alerte');
    expect(yesterday.alerts[0]!.items.map((i) => i.number).sort()).toEqual([String(a['numero_dpe']), String(b['numero_dpe'])].sort());
    // La base le garde aussi : un numéro n'est rangé qu'une fois par réseau, et rien ne change ni ne s'efface.
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM dpe_diagnoses'))!.n).toBe(3);
    await expect(t.db.run("UPDATE dpe_diagnoses SET energy_class = 'A'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM dpe_alert_items')).rejects.toThrow();
  });

  it('[R289] l’alerte ne contient que les communes de la zone de l’agent', async () => {
    const t = await setup();
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    await t.veille.watch(t.agentSam, { commune: 'Dijon', postcode: '21000' });
    // Un même code postal couvre d'autres communes : elles n'entrent pas.
    t.source.set('21240', [row(), row({ nom_commune_ban: 'Plombières-lès-Dijon' })]);
    t.source.set('21000', [row({ code_postal_ban: '21000', nom_commune_ban: 'Dijon' })]);
    await t.veille.run();
    const alex = await t.veille.alerts(t.agentAlex);
    const sam = await t.veille.alerts(t.agentSam);
    if (!alex.ok || !sam.ok) throw new Error('alerte');
    expect(alex.alerts.map((a) => a.commune)).toEqual(['Talant']);
    expect(alex.alerts.flatMap((a) => a.items.map((i) => i.address.commune))).toEqual(['Talant']);
    expect(sam.alerts.flatMap((a) => a.items.map((i) => i.address.commune))).toEqual(['Dijon']);
    expect((await t.db.all<{ commune: string }>('SELECT commune FROM dpe_diagnoses ORDER BY commune')).map((r) => r.commune)).toEqual(['Dijon', 'Talant']);
    // La commune sort des zones de l'agent : plus rien ne lui arrive, et l'alerte déjà rangée ne se montre plus.
    await t.db.run("UPDATE agent_zones SET ended_at = '2026-12-07T09:00:00.000Z' WHERE agent_id = ? AND commune = 'Talant'", [t.alex.id]);
    const after = await t.veille.alerts(t.agentAlex);
    if (!after.ok) throw new Error('alerte');
    expect(after.alerts).toEqual([]);
    t.source.set('21240', [row()]);
    t.source.calls.length = 0;
    await t.veille.run();
    expect(t.source.calls.map((c) => c.postcode)).toEqual(['21000']);
    expect((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM dpe_diagnoses WHERE commune = 'Talant'"))!.n).toBe(1);
  });

  it('[R289] un secteur fermé ou un agent parti ne reçoit plus rien ; l’alerte n’est lue que par son agent', async () => {
    const t = await setup();
    const s = await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    if (!s.ok) throw new Error('secteur');
    expect(await t.veille.unwatch(t.agentSam, s.sectorId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.veille.unwatch(t.agentAlex, s.sectorId)).toEqual({ ok: true });
    expect(await t.veille.unwatch(t.agentAlex, s.sectorId)).toEqual({ ok: false, rule: 'R289', code: 'deja_ferme' });
    t.source.set('21240', [row()]);
    expect(await t.veille.run()).toMatchObject({ inserted: 0 });
    expect(t.source.calls).toEqual([]);
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, '2026-11-01', '2026-12-01', 'demission_agent', 1, 'direction:d1', '2026-11-01T10:00:00.000Z')",
      [t.network.id, t.alex.id],
    );
    expect(await t.veille.run()).toMatchObject({ inserted: 0 });
    expect(await t.veille.alerts(t.agentAlex)).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.veille.alerts(t.direction)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R289, R100] la carte montre les diagnostics des zones avec la date d’interdiction de louer de M15', async () => {
    const t = await setup();
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    await t.veille.watch(t.agentSam, { commune: 'Dijon', postcode: '21000' });
    t.source.set('21240', [row({ etiquette_dpe: 'G' }), row({ etiquette_dpe: 'F' }), row({ etiquette_dpe: 'E' }), row({ etiquette_dpe: 'B' })]);
    t.source.set('21000', [row({ code_postal_ban: '21000', nom_commune_ban: 'Dijon' })]);
    await t.veille.run();
    const map = await t.veille.map(t.agentAlex);
    if (!map.ok) throw new Error('carte');
    expect(map.points).toHaveLength(4);
    const ban = Object.fromEntries(map.points.map((p) => [p.energyClass, p.rentBanFrom]));
    expect(ban).toEqual({ G: banDate('G'), F: banDate('F'), E: banDate('E'), B: null });
    expect(map.points.every((p) => p.position !== null && p.address.commune === 'Talant')).toBe(true);
    const fg = await t.veille.map(t.agentAlex, { classes: ['F', 'G'] });
    if (!fg.ok) throw new Error('carte');
    expect(fg.points.map((p) => p.energyClass).sort()).toEqual(['F', 'G']);
    expect(await t.veille.map(t.agentAlex, { commune: 'Dijon' })).toEqual({ ok: false, rule: 'R289', code: 'hors_zone' });
    expect(await t.veille.map(t.agentAlex, { classes: ['Z'] })).toEqual({ ok: false, rule: null, code: 'bad_classes' });
    const all = await t.veille.map(t.direction);
    if (!all.ok) throw new Error('carte');
    expect(all.points).toHaveLength(5);
    // Un autre réseau ne voit rien.
    expect(await t.veille.map(t.as('direction', 'd2', t.other.id))).toEqual({ ok: true, points: [] });
    // Au-delà de la fenêtre de la carte, le diagnostic sort de la carte.
    t.setClock(MONDAY_9H + 120 * DAY);
    expect(await t.veille.map(t.agentAlex)).toEqual({ ok: true, points: [] });
  });

  it('[R290] lettre « Au propriétaire » d’un logement F ou G : une par diagnostic, par l’agent de la zone, imprimée sans nom', async () => {
    const t = await setup();
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    t.source.set('21240', [row({ etiquette_dpe: 'G' }), row({ etiquette_dpe: 'F', nom_proprietaire: 'Jean Essai' }), row({ etiquette_dpe: 'D' })]);
    await t.veille.run();
    const map = await t.veille.map(t.agentAlex);
    if (!map.ok) throw new Error('carte');
    const byClass = (c: string) => map.points.find((p) => p.energyClass === c)!;
    const g = await t.veille.prepareLetter(t.agentAlex, byClass('G').diagnosisId);
    expect(g).toMatchObject({ ok: true, bannedFrom: '2025-01-01' });
    if (!g.ok) return;
    expect(g.body).toBe(ownerLetterText('G', '2025-01-01', '2026-12-07'));
    expect(await t.veille.prepareLetter(t.agentAlex, byClass('G').diagnosisId)).toEqual({ ok: false, rule: 'R290', code: 'deja_preparee' });
    expect(await t.veille.prepareLetter(t.agentAlex, byClass('D').diagnosisId)).toEqual({ ok: false, rule: 'R290', code: 'classe_sans_lettre' });
    // Hors de ses zones : refusé ; la direction ne signe aucune lettre.
    expect(await t.veille.prepareLetter(t.agentSam, byClass('F').diagnosisId)).toMatchObject({ ok: false, rule: 'R16', code: 'hors_zone' });
    expect(await t.veille.prepareLetter(t.direction, byClass('F').diagnosisId)).toMatchObject({ ok: false, rule: 'R16' });
    const f = await t.veille.prepareLetter(t.agentAlex, byClass('F').diagnosisId);
    expect(f).toMatchObject({ ok: true, bannedFrom: '2028-01-01' });
    const after = await t.veille.map(t.agentAlex, { classes: ['G'] });
    if (!after.ok) throw new Error('carte');
    expect(after.points[0]!.letterId).toBe(g.letterId);
    const printed = await t.veille.printLetter(t.agentAlex, g.letterId);
    if (!printed.ok) throw new Error('lettre');
    expect(printed.html).toContain('Au propriétaire<br>7 Rue des Essais<br>21240 Talant');
    expect(printed.html).toContain('Alex Agent');
    expect(printed.html).toContain(dayInFrench('2025-01-01'));
    expect(printed.html).not.toMatch(/Madame [A-Z]|Monsieur [A-Z]/);
    expect(await t.veille.printLetter(t.agentSam, g.letterId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.veille.printLetter(t.direction, g.letterId)).toMatchObject({ ok: true });
    await expect(t.db.run("UPDATE dpe_letters SET body = 'x'")).rejects.toThrow();
  });

  it('[R290] [R16] RC11 · la carte et l’alerte disent si la lettre est celle de l’agent qui lit', async () => {
    const t = await setup();
    // Alex et Sam couvrent tous deux Talant ; chacun suit le secteur.
    await t.zone(t.sam.id, 'Talant');
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    await t.veille.watch(t.agentSam, { commune: 'Talant', postcode: '21240' });
    t.source.set('21240', [row({ etiquette_dpe: 'G' }), row({ etiquette_dpe: 'F' }), row({ etiquette_dpe: 'D' })]);
    await t.veille.run();
    const before = await t.veille.map(t.agentAlex);
    if (!before.ok) throw new Error('carte');
    // Sans lettre : faux partout.
    expect(before.points.map((p) => p.letterMine)).toEqual([false, false, false]);
    const id = (c: string) => before.points.find((p) => p.energyClass === c)!.diagnosisId;
    const g = await t.veille.prepareLetter(t.agentAlex, id('G'));
    const f = await t.veille.prepareLetter(t.agentSam, id('F'));
    if (!g.ok || !f.ok) throw new Error('lettres');
    const mine = (points: readonly { diagnosisId: string; letterId: string | null; letterMine: boolean }[]) =>
      Object.fromEntries(points.map((p) => [p.diagnosisId, [p.letterId, p.letterMine]]));
    // La carte de chacun : sa lettre est à lui, celle de l'autre existe mais n'est pas la sienne.
    const alexMap = await t.veille.map(t.agentAlex);
    const samMap = await t.veille.map(t.agentSam);
    if (!alexMap.ok || !samMap.ok) throw new Error('carte');
    expect(mine(alexMap.points)).toEqual({ [id('G')]: [g.letterId, true], [id('F')]: [f.letterId, false], [id('D')]: [null, false] });
    expect(mine(samMap.points)).toEqual({ [id('G')]: [g.letterId, false], [id('F')]: [f.letterId, true], [id('D')]: [null, false] });
    // L'alerte du jour dit la même chose.
    const alexAlert = await t.veille.alerts(t.agentAlex);
    const samAlert = await t.veille.alerts(t.agentSam);
    if (!alexAlert.ok || !samAlert.ok) throw new Error('alerte');
    expect(mine(alexAlert.alerts.flatMap((a) => a.items))).toEqual(mine(alexMap.points));
    expect(mine(samAlert.alerts.flatMap((a) => a.items))).toEqual(mine(samMap.points));
    // La direction lit tout le réseau, mais ne signe aucune lettre : faux pour chacune.
    const direction = await t.veille.map(t.direction);
    if (!direction.ok) throw new Error('carte');
    expect(direction.points.filter((p) => p.letterId !== null)).toHaveLength(2);
    expect(direction.points.every((p) => p.letterMine === false)).toBe(true);
    // Ce que dit le point tient à l'impression : la lettre de l'autre reste refusée [R16].
    expect(await t.veille.printLetter(t.agentAlex, f.letterId)).toMatchObject({ ok: false, rule: 'R16', code: 'pas_sa_lettre' });
    expect(await t.veille.printLetter(t.agentAlex, g.letterId)).toMatchObject({ ok: true });
  });

  it('[R288, R13] aucun nom ni coordonnée de propriétaire rangé ; le journal ne porte aucune adresse', async () => {
    const t = await setup();
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    t.source.set('21240', [row({ nom_proprietaire: 'Jean Essai', telephone_proprietaire: '0611223344', mail: 'jean@exemple.test' }), row({ nom_rue_ban: 'Chez Essai Rue des Prés' })]);
    const report = await t.veille.run();
    expect(report).toMatchObject({ inserted: 1, skipped: { nom_dans_adresse: 1 } });
    const map = await t.veille.map(t.agentAlex);
    if (!map.ok) throw new Error('carte');
    await t.veille.prepareLetter(t.agentAlex, map.points[0]!.diagnosisId);
    // Aucune table de la veille n'a de colonne pour une personne, et rien du propriétaire n'est nulle part.
    for (const table of ['dpe_watch_sectors', 'dpe_watch_stops', 'dpe_diagnoses', 'dpe_alert_items', 'dpe_letters']) {
      const cols = (await t.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((c) => c.name);
      expect(cols.filter((c) => /owner|proprio|name|phone|mail|email/.test(c))).toEqual([]);
      const rows = await t.db.all(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows)).not.toMatch(/Jean|0611223344|exemple|Chez Essai/);
    }
    const events = await t.journal.all();
    expect(JSON.stringify(events)).not.toMatch(/Rue des Essais|Rue des Prés|Talant|21240|Jean/);
    expect((await verifyChain(events)).ok).toBe(true);
  });

  it('[R288, R289] un diagnostic et son alerte sont rangés ensemble : une panne au milieu ne perd jamais l’alerte', async () => {
    const t = await setup();
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    let fail = true;
    const flaky: SqlDatabase = {
      exec: (sql) => t.db.exec(sql),
      run: (sql, params) => t.db.run(sql, params),
      all: (sql, params) => t.db.all(sql, params),
      first: (sql, params) => t.db.first(sql, params),
      batch: async (statements) => {
        if (fail && statements.some((st) => st.sql.includes('dpe_alert_items'))) {
          fail = false;
          // Le diagnostic passe, puis la ligne d'alerte casse : le lot entier doit être annulé.
          await t.db.batch!([statements[0]!, { sql: 'INSERT INTO dpe_alert_items (sector_id) VALUES (NULL)' }]);
        }
        return t.db.batch!(statements);
      },
    };
    const v = new VeilleDpe(flaky, t.source.feed, t.journal, { now: t.now });
    t.source.set('21240', [row()]);
    await expect(v.run()).rejects.toThrow();
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM dpe_diagnoses'))!.n).toBe(0);
    expect(await v.run()).toMatchObject({ inserted: 1, alerted: 1 });
    const a = await v.alerts(t.agentAlex);
    if (!a.ok) throw new Error('alerte');
    expect(a.alerts[0]!.items).toHaveLength(1);
  });

  it('[R288] sans source, rien ne se passe ; une panne sur un code postal n’arrête pas les autres', async () => {
    const t = await setup();
    const silent = new VeilleDpe(t.db, null, t.journal, { now: t.now });
    await t.veille.watch(t.agentAlex, { commune: 'Talant', postcode: '21240' });
    await t.veille.watch(t.agentSam, { commune: 'Dijon', postcode: '21000' });
    expect(await silent.run()).toMatchObject({ inserted: 0 });
    const broken: DiagnosisFeed = {
      recent: async (q) => {
        if (q.postcode === '21240') throw new Error('HTTP 503');
        return [row({ code_postal_ban: '21000', nom_commune_ban: 'Dijon' })];
      },
    };
    const job = dpeWatchJob(t.db, broken, t.journal, { now: t.now });
    expect(job).toMatchObject({ name: 'veille_dpe.passage', hours: [7] });
    await expect(job.run({ job: job.name, slot: '2026-12-07T07', at: t.now() })).rejects.toThrow('HTTP 503');
    expect((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM dpe_diagnoses WHERE commune = 'Dijon'"))!.n).toBe(1);
  });
});

it('[R288] la source ADEME ne reçoit que le code postal et le jour, demande les seuls champs de la liste, et ne suit que sa propre adresse', async () => {
  const urls: string[] = [];
  const base = 'https://ademe.exemple.test/lines';
  const pages: Record<string, unknown>[] = [
    { results: [row()], next: `${base}?after=1` },
    { results: [row()], next: 'https://ailleurs.exemple.test/lines?after=2' },
  ];
  const fetcher = async (url: string) => {
    urls.push(url);
    const body = pages[urls.length - 1] ?? { results: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const feed = new AdemeDiagnosisFeed(fetcher, base);
  const rows = await feed.recent({ postcode: '21240', since: '2026-11-30' });
  expect(rows).toHaveLength(2);
  expect(urls).toHaveLength(2);
  const first = new URL(urls[0]!);
  expect(first.searchParams.get('qs')).toBe('code_postal_ban:"21240" AND date_reception_dpe:[2026-11-30 TO *]');
  expect(first.searchParams.get('select')).toBe(ADEME_FIELDS.join(','));
  expect(await feed.recent({ postcode: '21240" OR *', since: '2026-11-30' })).toEqual([]);
  const failing = new AdemeDiagnosisFeed(async () => ({ ok: false, status: 500, json: async () => null }), base);
  await expect(failing.recent({ postcode: '21240', since: '2026-11-30' })).rejects.toThrow('HTTP 500');
});

describeWithSqlite('AU098b · la veille d’un secteur de La Réunion', () => {
  it('[R100] [R290] un G de Saint-Denis porte l’interdiction de 2028 sur la carte et dans la lettre, au futur', async () => {
    const t = await setup();
    await t.zone(t.alex.id, 'Saint-Denis');
    await t.veille.watch(t.agentAlex, { commune: 'Saint-Denis', postcode: '97400' });
    t.source.set('97400', [row({ etiquette_dpe: 'G', code_postal_ban: '97400', nom_commune_ban: 'Saint-Denis', _geopoint: '-20.88,55.45' })]);
    await t.veille.run();
    const map = await t.veille.map(t.agentAlex, { commune: 'Saint-Denis' });
    if (!map.ok) throw new Error('carte');
    expect(map.points).toHaveLength(1);
    expect(map.points[0]!.rentBanFrom).toBe('2028-01-01');
    const letter = await t.veille.prepareLetter(t.agentAlex, map.points[0]!.diagnosisId);
    expect(letter).toMatchObject({ ok: true, bannedFrom: '2028-01-01' });
    if (!letter.ok) return;
    expect(letter.body).toBe(ownerLetterText('G', '2028-01-01', '2026-12-07'));
    expect(letter.body).not.toContain('2025');
  });
});

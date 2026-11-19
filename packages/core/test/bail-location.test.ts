import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  BauxLocation,
  Candidatures,
  ChoixProprietaire,
  HonorairesLocation,
  MisesEnLocation,
  REQUIRED_LEASE_FIELDS,
  leaseAnnexes,
  leaseDuration,
  type RentalFacts,
} from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, propriétaire, candidats, logement et adresse inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  mainRoomHundredths: 1_800,
  ceilingHeightCm: 250,
  localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true },
  firstLetting: true,
  gas: 'aucune',
  leaseStart: '2027-09-01',
  chargesMode: 'provision',
};
const INPUT = { address: '12 allée des Essais', ownerAddress: '3 chemin des Exemples, Ailleurs-Essai', habitat: 'collectif', landlord: 'physique', equipment: 'Cuisine équipée, cave', professionalCard: 'CPI 2101 2027 000 000 001' };
const FEES = { tenantCents: 34_000, tenantInventoryCents: 12_750, landlordCents: 34_000, landlordInventoryCents: 12_750, depositCents: 65_000 };
const BODY = [
  'Bail de {{bail.type}} entre {{bailleur.nom}}, domicilié {{bailleur.domicile}}, bailleur, et {{locataire.nom}}, locataire.',
  'Mandataire : {{reseau.nom}}, représenté par {{agent.nom}}, carte professionnelle {{mandataire.carte}}.',
  'Désignation : {{logement.habitat}}, {{logement.pieces}} pièces principales ; équipements : {{logement.equipements}}.',
  'Logement : {{logement.adresse}}, {{logement.commune}}, surface habitable {{logement.surface_habitable}}, classe énergie {{logement.classe_energie}}.',
  'Prise d’effet le {{bail.debut}}, pour {{bail.duree}}.',
  'Loyer : {{loyer.hors_charges}} ; charges : {{charges.montant}}, en {{charges.mode}} ; dépôt de garantie : {{depot.montant}}.',
  'Honoraires du locataire : {{honoraires.locataire}}, dont état des lieux {{honoraires.etat_des_lieux}} ; du bailleur : {{honoraires.bailleur}}.',
  'Annexes : {{annexes.liste}}.',
  'Fait le {{signature.date}} à {{signature.lieu}}.',
].join('\n\n');

describe('W06 · annexes du bail', () => {
  it('[R101] la liste des annexes suit le logement : diagnostics exigés, notice, état des lieux, inventaire pour un meublé', () => {
    expect(leaseAnnexes(['dpe', 'erp', 'surface_habitable'], false)).toEqual([
      'Diagnostic de performance énergétique',
      'État des risques',
      'Surface habitable',
      'Notice d’information relative aux droits et obligations des locataires et des bailleurs',
      'État des lieux d’entrée, établi à la remise des clés',
    ]);
    expect(leaseAnnexes(['dpe', 'erp', 'surface_habitable', 'crep'], true)).toContain('État des lieux d’entrée et inventaire détaillé du mobilier, établis à la remise des clés');
    expect(leaseAnnexes(['dpe', 'erp', 'surface_habitable', 'crep'], true)).toContain('Constat de risque d’exposition au plomb');
  });
});

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 60_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const put = (prefix: string) => {
    const r = `${prefix}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const identity = { state: async () => ({ identityVerifiedOn: '2027-07-10' }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const baux = new BauxLocation(db, listings, fees, choix, files, acces, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000', city: 'Villeneuve-Essai', rooms: 2 });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  /** Le logement louable, son barème, deux candidats complets présentés ; le choix rangé si demandé. */
  const ready = async (facts: Partial<RentalFacts> = {}, choose = true) => {
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    const id = c.ok ? c.value.listingId : '';
    expect((await listings.recordFacts(agent, id, { ...FACTS, ...facts })).ok).toBe(true);
    for (const kind of ['dpe', 'erp', 'surface_habitable']) expect((await listings.addAnnex(agent, id, { kind, ref: put(`location/${id}`), diagnosedOn: '2027-07-01' })).ok).toBe(true);
    await listings.check(agent, id);
    await fees.setCommune(agent, id, '21999');
    expect((await fees.record(agent, id, FEES)).ok).toBe(true);
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const pid = (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Candidat${i}`, lastName: 'Inventé' })).id;
      const a = await apps.apply(agent, id, { personId: pid });
      const aid = a.ok ? a.value.applicationId : '';
      for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire']) await apps.addPiece(agent, aid, { holder: 'candidat', sort, ref: put(`location/${id}/candidatures/${aid}`), sha256: SHA });
      ids.push(aid);
    }
    const p = await choix.present(agent, id);
    if (choose) {
      const r = await choix.recordChoice(agent, id, { presentationId: p.ok ? p.value.presentationId : '', applicationId: ids[1]!, decidedAt: new Date(clock).toISOString(), channel: 'ecrit', proofRef: put(`location/${id}/choix`) });
      expect(r.ok).toBe(true);
    }
    return id;
  };
  const template = async (kind = 'bail_vide', body = BODY) => {
    const r = await baux.createTemplate(dir, kind, body);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const inp = (id: string) => ({ ...INPUT, noticeRef: put(`location/${id}/bail`) });
  return { db, network, listings, fees, baux, agent, other, dir, compliance, ready, template, inp, put, owner, bea };
}

describeWithSqlite('W06 · bail depuis les modèles', () => {
  it('AU015 · dans une commune encadrée, le bail dit les loyers de référence et le complément ; un modèle sans leur place laisse le bail à compléter', async () => {
    const t = await setup();
    await t.db.run(
      "INSERT INTO commune_rental_rules (id, network_id, insee_code, rule, effective_from, effective_until, source, source_date, recorded_by, recorded_at) VALUES ('r1', ?, '21999', 'encadrement_loyers', '2027-01-01', NULL, 'Arrêté inventé', '2026-12-01', 'direction:d', '2027-01-02T00:00:00.000Z')",
      [t.network.id],
    );
    const rentControl = { decree: 'n° 0000-00', readOn: '2027-07-01', referenceCentsPerM2: 2_000, majoredCentsPerM2: 2_400, complementCents: 5_000, complementReason: 'Terrasse de 40 m² avec vue dégagée, rare dans le quartier' };
    await t.template();
    const id = await t.ready({ rentControl });
    const without = await t.baux.generate(t.agent, id, t.inp(id));
    expect(without).toMatchObject({ ok: true, value: { status: 'incomplet', missing: ['loyer.encadrement'] } });
    await t.template('bail_vide', `${BODY}\nEncadrement des loyers : {{loyer.encadrement}}.`);
    const full = await t.baux.generate(t.agent, id, t.inp(id));
    expect(full).toMatchObject({ ok: true, value: { status: 'complet', missing: [] } });
    expect(full.ok && full.value.content).toContain(
      'loyer de référence 20 € par m² et par mois, loyer de référence majoré 24 € par m² et par mois (1020 € par mois pour ce logement), arrêté n° 0000-00 ; loyer de base 600 € par mois ; complément de loyer 50 € par mois, justifié par : Terrasse de 40 m² avec vue dégagée, rare dans le quartier',
    );
  });

  it('[R105] [R102] le bail se fait pour le candidat choisi, chaque montant venant des données contrôlées', async () => {
    const t = await setup();
    await t.template();
    const id = await t.ready();
    const r = await t.baux.generate(t.agent, id, t.inp(id));
    expect(r).toMatchObject({ ok: true, value: { version: 1, mode: 'essai', status: 'complet', missing: [] } });
    const html = r.ok ? r.value.content : '';
    expect(html).toContain('Candidat2 Inventé');
    expect(html).not.toContain('Candidat1');
    expect(html).toContain('Bailleur Inventé');
    expect(html).toContain('Loyer : 650 € par mois ; charges : 50 € par mois, en provision, avec régularisation annuelle ; dépôt de garantie : 650 €.');
    expect(html).toContain('Honoraires du locataire : 467,50 € TTC, dont état des lieux 127,50 € TTC ; du bailleur : 467,50 € TTC.');
    expect(html).toContain('pour trois ans');
    expect(html).toContain('surface habitable 42,50 m²');
    expect(html).toContain('Annexes : Diagnostic de performance énergétique ; État des risques ; Surface habitable ; Notice d’information');
    expect(html).toContain('DOCUMENT D’ESSAI');
    expect(html).toContain('Mandataire : Réseau Essai, représenté par Alex Essai, carte professionnelle CPI 2101 2027 000 000 001.');
    expect(html).toContain('Désignation : immeuble collectif, 2 pièces principales');
    expect(html).toContain('domicilié 3 chemin des Exemples');
    expect(await t.baux.current(t.agent.networkId, id)).toMatchObject({ leaseId: r.ok ? r.value.leaseId : '', mode: 'essai', complete: true });
    // Chaque annexe jointe l'est par sa référence : diagnostics exigés et notice d'information.
    const joined = JSON.parse((await t.db.first<{ annexes: string }>('SELECT annexes FROM rental_leases'))!.annexes) as { kind: string; ref: string }[];
    expect(joined.map((a) => a.kind).sort()).toEqual(['dpe', 'erp', 'notice_information', 'surface_habitable']);
    for (const a of joined) expect(a.ref).toMatch(/^location\//);
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), noticeRef: `location/${id}/bail/${uuid()}.pdf` })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), noticeRef: 'ailleurs/x.pdf' })).toEqual({ ok: false, rule: null, code: 'bad_notice_ref' });
    // Le journal ne garde ni nom, ni adresse, ni montant.
    for (const e of await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'location.bail'")) expect(e.data).not.toMatch(/Inventé|allée|650/);
  });

  it('[R105] sans choix du propriétaire, aucun bail ; [R101] sans logement louable, aucun bail', async () => {
    const t = await setup();
    await t.template();
    const id = await t.ready({}, false);
    expect(await t.baux.generate(t.agent, id, t.inp(id))).toEqual({ ok: false, rule: 'R105', code: 'no_choice' });
    const t2 = await setup();
    await t2.template();
    const id2 = await t2.ready({ leaseStart: '2027-07-14' });
    // L'état des risques du 1er juillet vaut jusqu'au 31 décembre ; on passe au 1er janvier 2028 : il est échu.
    clock = Date.parse('2028-01-01T08:00:00.000Z');
    expect(await t2.baux.generate(t2.agent, id2, t2.inp(id2))).toEqual({ ok: false, rule: 'R101', code: 'not_rentable' });
    // Un bail ne prend pas effet dans le passé, même pour un logement encore louable.
    const t3 = await setup();
    await t3.template();
    const id3 = await t3.ready({ leaseStart: '2027-07-20' });
    clock = Date.parse('2027-07-21T08:00:00.000Z');
    expect(await t3.baux.generate(t3.agent, id3, t3.inp(id3))).toEqual({ ok: false, rule: null, code: 'lease_start_passed' });
  });

  it('[R40] un champ qui manque rend le bail incomplet, jamais inventé ; un modèle validé fait un bail réel', async () => {
    const t = await setup();
    const tpl = await t.template();
    const id = await t.ready();
    const r = await t.baux.generate(t.agent, id, { ...t.inp(id), address: undefined });
    expect(r).toMatchObject({ ok: true, value: { status: 'incomplet', missing: ['logement.adresse'] } });
    // Chaque mention exigée de la loi de 1989 sans valeur laisse le bail incomplet.
    const bare = await t.baux.generate(t.agent, id, { landlord: 'physique' });
    expect(bare.ok && bare.value.missing.sort()).toEqual(['annexe.notice_information', 'bailleur.domicile', 'logement.adresse', 'logement.equipements', 'logement.habitat', 'mandataire.carte']);
    expect(bare.ok && bare.value.content).toContain('[à compléter : carte professionnelle de l’agent immobilier]');
    expect(bare.ok && bare.value.content).not.toMatch(/\[à compléter : [^\]]*mandataire/);
    expect(r.ok && r.value.content).toContain('[à compléter : adresse du logement]');
    expect(await t.baux.current(t.agent.networkId, id)).toMatchObject({ complete: false });
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), address: '<script>' })).toEqual({ ok: false, rule: null, code: 'bad_address' });
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), professionalCard: '12345' })).toEqual({ ok: false, rule: null, code: 'bad_card' });
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), habitat: 'chateau' })).toEqual({ ok: false, rule: null, code: 'bad_habitat' });
    expect(await t.baux.validateTemplate(t.dir, tpl.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.baux.validateTemplate(t.compliance, tpl.id)).toEqual({ ok: true, value: true });
    expect(await t.baux.validateTemplate(t.compliance, tpl.id)).toEqual({ ok: false, rule: null, code: 'not_essai' });
    const real = await t.baux.generate(t.agent, id, t.inp(id));
    expect(real).toMatchObject({ ok: true, value: { version: 3, mode: 'reel', status: 'complet' } });
    expect(real.ok && real.value.content).not.toContain('DOCUMENT D’ESSAI');
    // Un bailleur sans nom de famille n'est jamais nommé par son seul prénom : le bail reste à compléter.
    await t.db.run('UPDATE persons SET last_name = NULL WHERE id = ?', [t.owner.id]);
    const half = await t.baux.generate(t.agent, id, t.inp(id));
    expect(half).toMatchObject({ ok: true, value: { status: 'incomplet', missing: ['bailleur.nom'] } });
    expect(half.ok && half.value.content).not.toContain('Bailleur Inventé');
    await t.db.run("UPDATE persons SET last_name = 'Inventé' WHERE id = ?", [t.owner.id]);
    // Une nouvelle version d'essai du modèle ne remplace pas la version validée : le modèle en vigueur reste celui-ci.
    await t.template();
    const again = await t.baux.generate(t.agent, id, t.inp(id));
    expect(again).toMatchObject({ ok: true, value: { mode: 'reel' } });
    expect((await t.db.first<{ template_id: string }>('SELECT template_id FROM rental_leases ORDER BY version DESC LIMIT 1'))!.template_id).toBe(tpl.id);
    await expect(t.db.run("UPDATE rental_leases SET content = 'x'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run("UPDATE rental_lease_templates SET body = 'x'")).rejects.toThrow(/ne change plus/);
  });

  it('[R40] [R102] un modèle sans les champs exigés, ou avec un champ inconnu, est refusé ; la direction seule écrit', async () => {
    const t = await setup();
    for (const f of REQUIRED_LEASE_FIELDS) {
      const body = BODY.replace(`{{${f}}}`, '…');
      expect(await t.baux.createTemplate(t.dir, 'bail_vide', body), f).toEqual({ ok: false, rule: 'R40', code: 'missing_required_field', field: f });
    }
    expect(await t.baux.createTemplate(t.dir, 'bail_vide', `${BODY}\n\n{{locataire.revenus}}`)).toEqual({ ok: false, rule: 'R40', code: 'unknown_field' });
    expect(await t.baux.createTemplate(t.dir, 'bail_vide', `${BODY}\n\n{{ mal ecrit`)).toEqual({ ok: false, rule: 'R40', code: 'unknown_field' });
    expect(await t.baux.createTemplate(t.agent, 'bail_vide', BODY)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.baux.createTemplate(t.dir, 'bail_commercial', BODY)).toEqual({ ok: false, rule: null, code: 'unknown_kind' });
  });

  it('[R102] un meublé prend le modèle meublé, un an ; un changement de faits rend le bail caduc', async () => {
    const t = await setup();
    await t.template();
    const id = await t.ready({ furnished: true, chargesMode: 'forfait' });
    expect(await t.baux.generate(t.agent, id, t.inp(id))).toEqual({ ok: false, rule: null, code: 'no_template' });
    await t.template('bail_meuble');
    const r = await t.baux.generate(t.agent, id, t.inp(id));
    expect(r.ok && r.value.content).toContain('pour un an');
    expect(r.ok && r.value.content).toContain('en forfait');
    expect(r.ok && r.value.annexes).toContain('État des lieux d’entrée et inventaire détaillé du mobilier, établis à la remise des clés');
    await t.listings.recordFacts(t.agent, id, { ...FACTS, furnished: true, chargesMode: 'forfait', rentCents: 60_000 });
    expect(await t.baux.current(t.agent.networkId, id)).toBeNull();
  });

  it('[R101] un diagnostic remplacé depuis le bail rend ce bail caduc : un nouveau bail joint la nouvelle annexe', async () => {
    const t = await setup();
    await t.template();
    const id = await t.ready();
    const r = await t.baux.generate(t.agent, id, t.inp(id));
    expect(await t.baux.current(t.agent.networkId, id)).toMatchObject({ leaseId: r.ok ? r.value.leaseId : '' });
    const newErp = t.put(`location/${id}`);
    expect((await t.listings.addAnnex(t.agent, id, { kind: 'erp', ref: newErp, diagnosedOn: '2027-07-10' })).ok).toBe(true);
    await t.listings.check(t.agent, id);
    expect(await t.baux.current(t.agent.networkId, id)).toBeNull();
    const again = await t.baux.generate(t.agent, id, t.inp(id));
    expect(await t.baux.current(t.agent.networkId, id)).toMatchObject({ leaseId: again.ok ? again.value.leaseId : '' });
    const joined = JSON.parse((await t.db.first<{ annexes: string }>('SELECT annexes FROM rental_leases ORDER BY version DESC LIMIT 1'))!.annexes) as { kind: string; ref: string }[];
    expect(joined.find((a) => a.kind === 'erp')?.ref).toBe(newErp);
  });

  it('[R16] l’agent du logement et la direction font le bail ; un autre agent est refusé', async () => {
    const t = await setup();
    await t.template();
    const id = await t.ready();
    expect(await t.baux.generate(t.other, id, t.inp(id))).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.baux.generate(t.compliance, id, t.inp(id))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.baux.generate(t.dir, id, t.inp(id))).ok).toBe(true);
    // Le bailleur suivi par un autre agent : ses nom et domicile ne sortent pas dans un bail fait par Alex.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.bea.id, t.owner.id]);
    const r = await t.baux.generate(t.agent, id, t.inp(id));
    expect(r).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify(r)).not.toContain('Bailleur');
  });
});

describe('AU096 · la durée du bail par la loi, selon le bailleur et la sorte de location', () => {
  it('[R40] vide : 3 ans pour une personne, 6 ans pour une société ; meublé : 1 an, 9 mois pour un étudiant ; mobilité : aucun', () => {
    expect(leaseDuration(false, 'physique', 'standard')).toBe('trois ans');
    expect(leaseDuration(false, 'morale', 'standard')).toBe('six ans');
    expect(leaseDuration(true, 'morale', 'standard')).toBe('un an');
    expect(leaseDuration(true, 'physique', 'etudiant')).toBe('neuf mois');
    expect(leaseDuration(false, 'physique', 'etudiant')).toBeNull();
    expect(leaseDuration(true, 'physique', 'mobilite')).toBeNull();
  });
});

describeWithSqlite('AU096 · la qualité du bailleur dite, jamais supposée', () => {
  it('[R40] sans bailleur dit, aucun bail ; une société fait un bail vide de six ans ; bail mobilité et meublé étudiant refusés avant tout', async () => {
    const t = await setup();
    await t.template();
    const id = await t.ready();
    const { landlord: _l, ...noLandlord } = t.inp(id) as Record<string, unknown>;
    expect(await t.baux.generate(t.agent, id, noLandlord)).toEqual({ ok: false, rule: null, code: 'missing_landlord' });
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), variant: 'mobilite' })).toEqual({ ok: false, rule: null, code: 'bail_mobilite_refuse' });
    // Le meublé étudiant n'a pas encore son modèle validé : refusé, jamais fait avec le modèle du meublé ordinaire.
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), variant: 'etudiant' })).toEqual({ ok: false, rule: null, code: 'bail_etudiant_refuse' });
    expect(await t.baux.generate(t.agent, id, { ...t.inp(id), variant: 'autre' })).toEqual({ ok: false, rule: null, code: 'bad_variant' });
    const r = await t.baux.generate(t.agent, id, { ...t.inp(id), landlord: 'morale' });
    expect(r.ok && r.value.content).toContain('six ans');
  });
});

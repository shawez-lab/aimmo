/**
 * AU007 · Les mentions de l'intervenant suivent son statut réel, sur la page, la fiche et les exports [R43, R152].
 * Agents, immatriculations et titulaire inventés.
 */
import { describe, expect, it } from 'vitest';
import { PageBien, computeMentions, type MentionsInput } from '../src/annonces/index.ts';
import { PageAgent } from '../src/attirer/page-agent.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';
import { rangerStatut, TITULAIRE_TEST } from './statut-agent-jeu.ts';

const PRO = { firstName: 'Alex', lastName: 'Agent', status: 'agent_commercial', rsacNumber: '900 000 001', rsacRegistry: 'Dijon', cardHolder: TITULAIRE_TEST } as const;
const BASE: MentionsInput = {
  kind: 'land',
  terms: { priceEur: 65000, feeEur: 5000, feeCharge: 'vendeur' },
  sheet: { characteristics: null, energy: null, coownership: { isCoownership: false }, risks: { inRiskZone: false }, media: [] } as never,
  cardNumber: 'CPI 2101 2027 000 000 001',
  intervenant: PRO,
  today: '2027-03-01',
};
const missing = (input: MentionsInput) => computeMentions(input).items.flatMap((i) => (i.status === 'manquante' ? [`${i.id}:${i.reason}`] : []));

describe('AU007 · mention de l’intervenant', () => {
  it('[R43] [R152] la mention dit le statut d’agent commercial, le greffe et le numéro RSAC, et le titulaire qui l’habilite', () => {
    const r = computeMentions(BASE);
    expect(r.complete).toBe(true);
    expect(r.text).toContain('Annonce présentée par Alex Agent, agent commercial immatriculé au registre spécial des agents commerciaux (RSAC) de Dijon sous le n° 900 000 001, habilité par Réseau Test SAS');
    expect(r.text).not.toMatch(/mandataire/i);
    // La carte reste celle du titulaire, juste après.
    expect(r.text.split('\n').slice(-2)[1]).toBe('Carte professionnelle n° CPI 2101 2027 000 000 001.');
  });

  it('[R43] sans statut rangé ou sans titulaire, la mention manque et bloque', () => {
    expect(missing({ ...BASE, intervenant: null })).toEqual(['intervenant:statut_intervenant_inconnu']);
    expect(missing({ ...BASE, intervenant: { ...PRO, rsacNumber: ' ' } })).toEqual(['intervenant:statut_intervenant_inconnu']);
    expect(missing({ ...BASE, intervenant: { ...PRO, rsacRegistry: '' } })).toEqual(['intervenant:statut_intervenant_inconnu']);
    expect(missing({ ...BASE, intervenant: { ...PRO, status: 'titulaire' as never } })).toEqual(['intervenant:statut_intervenant_inconnu']);
    expect(missing({ ...BASE, intervenant: { ...PRO, cardHolder: null } })).toEqual(['intervenant:titulaire_inconnu']);
    const blocked = computeMentions({ ...BASE, intervenant: null });
    expect(blocked.complete).toBe(false);
    expect(blocked.publishedPriceEur).toBeNull();
  });
});

describeWithSqlite('AU007 · page, fiche et exports suivent le statut réel de l’agent du bien', () => {
  const publish = async (options: { statut?: boolean } = {}) => {
    const t = await setupAnnonce(options);
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    return t;
  };

  it('[R43] constat : sans statut rangé pour l’agent, l’annonce ne se valide pas et ne part pas, ni sur la page ni vers un portail', async () => {
    const t = await setupAnnonce({ statut: false });
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    const refused = await t.annonces.validate(t.agent, t.draftId);
    expect(refused).toMatchObject({ ok: false, rule: 'R43', code: 'mentions_incomplete', missing: [{ id: 'intervenant', status: 'manquante', reason: 'statut_intervenant_inconnu' }] });
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    expect((await t.publication.sync(t.network.id, t.propertyId)).created).toBe(false);
    expect(await new PageBien(t.db, t.acces, t.journal, { now: t.now }).page(t.network.id, t.propertyId)).toBeNull();
    for (const c of t.channels) expect(c.received).toEqual([]);
    // Le statut rangé, l'annonce se valide et le passage suivant la publie.
    await rangerStatut(t.db, t.journal, t.now, t.direction, [t.alexId]);
    expect((await t.annonces.validate(t.agent, t.draftId)).ok).toBe(true);
    expect((await t.publication.sync(t.network.id, t.propertyId)).created).toBe(true);
  });

  it('[R152] la page, la fiche imprimable et chaque export portent le statut et le numéro RSAC propres à l’agent', async () => {
    const t = await publish();
    await t.publication.sync(t.network.id, t.propertyId);
    const pages = new PageBien(t.db, t.acces, t.journal, { now: t.now });
    const line = 'Annonce présentée par Alex Agent, agent commercial immatriculé au registre spécial des agents commerciaux (RSAC) de Dijon sous le n° 900 000 001, habilité par Réseau Test SAS';
    expect(await pages.page(t.network.id, t.propertyId)).toContain(line);
    expect(await pages.print(t.network.id, t.propertyId)).toContain(line);
    for (const c of t.channels) expect(c.received.at(-1)!.mentions).toContain(line);
  });

  it('[R152] le statut suit l’intervenant : nouvel agent du bien, nouvelle immatriculation, agent parti', async () => {
    const t = await publish();
    await t.publication.sync(t.network.id, t.propertyId);
    const latest = async () => (await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [t.propertyId]))!.payload;
    // La direction range une nouvelle immatriculation : la version suivante la porte.
    await new PageAgent(t.db, t.journal, { now: t.now }).setLegalMentions(t.direction, t.alexId, { rsacNumber: '900000002', rsacRegistry: 'Beaune' });
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await latest()).toContain('RSAC) de Beaune sous le n° 900 000 002');
    // Le bien passe à Sam : ses mentions à lui.
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.userId, t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await latest()).toContain('Annonce présentée par Sam Agent, agent commercial');
    expect(await latest()).not.toContain('Alex Agent');
    // Sam part sans successeur : la mention manque, l'annonce est retirée au passage suivant.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.userId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(JSON.parse(await latest()).state).toBe('retiree');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  FicheClient,
  ReconnaissanceBien,
  applyMigrations,
  fromSyncSqlite,
  normalizeUrl,
  referencesIn,
  urlsIn,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const NOW = new Date('2026-10-26T09:00:00.000Z');

describe('indices dans un texte', () => {
  it('liens normalisés, avec ou sans protocole', () => {
    expect(normalizeUrl('https://www.Shawez-Immo.com/biens/383-appartement-dijon/?utm=x#photos')).toBe('shawez-immo.com/biens/383-appartement-dijon');
    expect(urlsIn('Vu ici : www.exemple-portail.fr/annonce/12345. Merci')).toEqual(['exemple-portail.fr/annonce/12345']);
    expect(urlsIn('Bonjour, toujours dispo ?')).toEqual([]);
  });

  it('une référence n\'est lue qu\'après « réf » ou « référence », jamais un nombre seul', () => {
    expect(referencesIn('Bonjour, la réf. 383 est-elle dispo ?')).toEqual(['383']);
    expect(referencesIn('Référence : AB-12, ref 99')).toEqual(['ab-12', '99']);
    expect(referencesIn('Le 383 000 € pour 95 m2 ?')).toEqual([]);
  });
});

describeWithSqlite('reconnaître le bien dont parle un message', () => {
  let db: SqlDatabase;
  let net: string;
  let reco: ReconnaissanceBien;
  let homes: Record<string, string>;

  beforeEach(async () => {
    db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const fiches = new FicheClient(db, { now: () => NOW });
    net = (await fiches.createNetwork('Réseau test')).id;
    const agent = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Test' })).id;
    homes = {};
    for (const reference of ['383', '394', '403']) {
      homes[reference] = (
        await fiches.createProperty({ networkId: net, agentId: agent, reference, kind: 'home', status: 'available', priceEur: 200000 })
      ).id;
    }
    reco = new ReconnaissanceBien(db);
    await reco.link({ networkId: net, propertyId: homes['383']!, kind: 'post', value: 'video-ig-1', at: NOW });
    await reco.link({ networkId: net, propertyId: homes['394']!, kind: 'post', value: 'video-ig-2', at: NOW });
    await reco.link({ networkId: net, propertyId: homes['403']!, kind: 'post', value: 'video-fb-3', at: NOW });
    await reco.link({ networkId: net, propertyId: homes['394']!, kind: 'portal', value: 'portail-test:ann-777', at: NOW });
    await reco.link({ networkId: net, propertyId: homes['403']!, kind: 'url', value: 'https://www.exemple-portail.fr/annonce/555', at: NOW });
  });

  it('[R20] 3 commentaires sur 3 vidéos différentes donnent 3 biens différents et justes', async () => {
    const answers = await Promise.all(
      [
        ['video-ig-1', '383'],
        ['video-ig-2', '394'],
        ['video-fb-3', '403'],
      ].map(async ([postRef, reference]) => [reference, await reco.recognize(net, { postRef: postRef!, text: 'Toujours dispo ? Quel prix ?' })] as const),
    );
    for (const [reference, answer] of answers) {
      expect(answer).toMatchObject({ status: 'recognized', property: { id: homes[reference!] }, via: ['post'] });
    }
  });

  it('lien d\'annonce du site, lien noté, référence citée, référence de portail : chacun mène au bon bien', async () => {
    expect(await reco.recognize(net, { text: 'Vu sur https://shawez-immo.com/biens/383-appartement-dijon/' })).toMatchObject({ status: 'recognized', property: { id: homes['383'] }, via: ['url'] });
    expect(await reco.recognize(net, { text: 'Celle-ci : exemple-portail.fr/annonce/555' })).toMatchObject({ status: 'recognized', property: { id: homes['403'] } });
    expect(await reco.recognize(net, { text: 'Bonjour, la réf 394 est-elle libre ?' })).toMatchObject({ status: 'recognized', property: { id: homes['394'] }, via: ['reference'] });
    expect(await reco.recognize(net, { portal: 'Portail-Test', subject: 'Demande pour l\'annonce réf. ANN-777', text: 'Bonjour' })).toMatchObject({
      status: 'recognized',
      property: { id: homes['394'] },
      via: ['portal'],
    });
    expect(await reco.recognize(net, { propertyRef: '/biens/403-terrain-a-batir-arceau/' })).toMatchObject({ status: 'recognized', property: { id: homes['403'] } });
    expect(await reco.recognize(net, { propertyRef: '383' })).toMatchObject({ status: 'recognized', property: { id: homes['383'] } });
  });

  it('[R20] un lien ou une référence inconnus donnent « bien non reconnu »', async () => {
    expect(await reco.recognize(net, { text: 'Et la réf 999 ?' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'unknown' });
    expect(await reco.recognize(net, { text: 'https://shawez-immo.com/biens/999-maison/' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'unknown' });
    expect(await reco.recognize(net, { postRef: 'video-inconnue' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'unknown' });
    expect(await reco.recognize(net, { text: 'Bonjour, toujours dispo ?' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'no_clue' });
  });

  it('[R20] deux biens possibles donnent « bien non reconnu »', async () => {
    // Commentaire sous la vidéo du 383 qui cite la référence du 394.
    expect(await reco.recognize(net, { postRef: 'video-ig-1', text: 'Et la réf 394 ?' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'ambiguous' });
    // Une même publication notée pour deux biens.
    await reco.link({ networkId: net, propertyId: homes['403']!, kind: 'post', value: 'video-ig-1', at: NOW });
    expect(await reco.recognize(net, { postRef: 'video-ig-1' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'ambiguous' });
  });

  it('[R20] une référence inconnue citée sous la vidéo d\'un bien : dans le doute, aucun bien', async () => {
    expect(await reco.recognize(net, { postRef: 'video-ig-2', text: 'Vous avez la réf 999 ?' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'ambiguous' });
  });

  it('[R20] une annonce du site inconnue ou une référence inconnue donnée par le canal, sous la vidéo d\'un bien : aucun bien', async () => {
    expect(await reco.recognize(net, { postRef: 'video-ig-1', text: 'https://shawez-immo.com/biens/999-maison' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'ambiguous' });
    expect(await reco.recognize(net, { postRef: 'video-ig-1', propertyRef: '999' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'ambiguous' });
    // Un lien quelconque, lui, ne contredit rien.
    expect(await reco.recognize(net, { postRef: 'video-ig-1', text: 'Vu aussi https://exemple.org/conseils' })).toMatchObject({ status: 'recognized', property: { id: homes['383'] } });
    expect(await reco.recognize(net, { propertyRef: '/estimation-en-ligne/' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'unknown' });
  });

  it('[R20] références à tiret : la page d\'annonce mène au bon bien, ou à aucun si deux sont possibles', async () => {
    const fiches = new FicheClient(db, { now: () => NOW });
    const agent = (await db.first<{ id: string }>('SELECT id FROM agents'))!.id;
    const hyphen = (await fiches.createProperty({ networkId: net, agentId: agent, reference: '500-1', kind: 'home', status: 'available' })).id;
    expect(await reco.recognize(net, { text: 'https://shawez-immo.com/biens/500-1-maison-dijon' })).toMatchObject({ status: 'recognized', property: { id: hyphen } });
    await fiches.createProperty({ networkId: net, agentId: agent, reference: '500', kind: 'home', status: 'available' });
    expect(await reco.recognize(net, { text: 'https://shawez-immo.com/biens/500-1-maison-dijon' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'ambiguous' });
  });

  it('un lien mal formé ne fait pas échouer la reconnaissance', async () => {
    expect(normalizeUrl('https://shawez-immo.com/biens/%')).toBeNull();
    expect(await reco.recognize(net, { postRef: 'video-ig-2', text: 'https://shawez-immo.com/biens/%' })).toMatchObject({ status: 'recognized', property: { id: homes['394'] } });
  });

  it('un nombre seul dans le texte n\'est pas une référence', async () => {
    expect(await reco.recognize(net, { text: 'Je cherche à 383 000 € maximum' })).toEqual({ status: 'unrecognized', rule: 'R20', reason: 'no_clue' });
  });

  it('un bien d\'un autre réseau n\'est jamais reconnu', async () => {
    const fiches = new FicheClient(db, { now: () => NOW });
    const other = (await fiches.createNetwork('Autre réseau')).id;
    expect(await reco.recognize(other, { postRef: 'video-ig-1' })).toMatchObject({ status: 'unrecognized', reason: 'unknown' });
    expect(await reco.recognize(other, { text: 'réf 383' })).toMatchObject({ status: 'unrecognized', reason: 'unknown' });
  });

  it('[R17] une correspondance retirée ne vaut plus, et sa ligne reste', async () => {
    expect(await reco.retire({ networkId: net, propertyId: homes['383']!, kind: 'post', value: 'video-ig-1', at: NOW })).toBe(1);
    expect(await reco.recognize(net, { postRef: 'video-ig-1' })).toMatchObject({ status: 'unrecognized', reason: 'unknown' });
    expect(await db.all('SELECT * FROM property_links WHERE value = ?', ['video-ig-1'])).toHaveLength(1);
    await expect(db.run('DELETE FROM property_links')).rejects.toThrow();
  });
});

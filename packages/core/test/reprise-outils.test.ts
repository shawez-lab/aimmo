import { beforeEach, describe, expect, it } from 'vitest';
import {
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  RepriseSite,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  parseCsv,
  readToolCsv,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

const NOW = new Date('2026-10-26T09:00:00.000Z');

describe('lecture des CSV', () => {
  it('guillemets, séparateur point-virgule, retour à la ligne dans un champ, marque d\'octets', () => {
    expect(parseCsv('﻿a;b;c\r\n"x;1";"dit ""oui""";"deux\nlignes"\n')).toEqual([
      ['a', 'b', 'c'],
      ['x;1', 'dit "oui"', 'deux\nlignes'],
    ]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('un fichier sans colonne de coordonnées est refusé', async () => {
    await expect(readToolCsv('Nom;Ville\nA;Dijon\n', 'exclusion_list', NOW)).rejects.toThrow(/colonne/);
  });

  it('[R04] GoHighLevel : « ne pas déranger » rempli vaut arrêt ; vide ou false, non', async () => {
    const csv = [
      'Contact Id,First Name,Last Name,Email,Phone,DND',
      'g1,Alix,Exemple,alix@example.org,0610000001,true',
      'g2,Bao,Exemple,bao@example.org,,false',
      'g3,Cyd,Exemple,cyd@example.org,,',
      'g4,Dan,Exemple,dan@example.org,,DND all',
    ].join('\n');
    const reading = await readToolCsv(csv, 'gohighlevel', NOW);
    expect(reading.contacts.map((c) => [c.origin, c.exclusion])).toEqual([
      ['gohighlevel:g1', 'stop'],
      ['gohighlevel:g2', null],
      ['gohighlevel:g3', null],
      ['gohighlevel:g4', 'stop'],
    ]);
  });

  it('[R04] ManyChat : un abonnement refusé ou désabonné vaut arrêt', async () => {
    const csv = ['User ID;First Name;Instagram Username;Phone;Subscribed', 'm1;Eli;eli.exemple;;yes', 'm2;Fé;@fe.exemple;;no', 'm3;Gil;;+33610000003;unsubscribed'].join('\n');
    const reading = await readToolCsv(csv, 'manychat', NOW);
    expect(reading.contacts.map((c) => [c.origin, c.instagrams, c.exclusion])).toEqual([
      ['manychat:m1', ['eli.exemple'], null],
      ['manychat:m2', ['@fe.exemple'], 'stop'],
      ['manychat:m3', [], 'stop'],
    ]);
  });

  it('une ligne sans coordonnée valable est signalée par son numéro, jamais jetée en silence', async () => {
    const csv = ['Email;Téléphone;Nom', 'pas-un-mail;12;Inconnu', ';;Vide de coordonnées', 'ok@example.org;;Bon', ';;'].join('\n');
    const reading = await readToolCsv(csv, 'exclusion_list', NOW);
    expect(reading.unreadableLines).toEqual([2, 3]);
    expect(reading.flagged).toBe(2);
    expect(reading.contacts).toHaveLength(1);
  });

  it('la clé d\'origine d\'une ligne sans identifiant ne contient aucune coordonnée et ne change pas d\'un export à l\'autre', async () => {
    const a = await readToolCsv('Email\nzoe@example.org\n', 'exclusion_list', NOW);
    const b = await readToolCsv('E-mail\nZOE@example.org\n', 'exclusion_list', NOW);
    expect(a.contacts[0]?.origin).toBe(b.contacts[0]?.origin);
    expect(a.contacts[0]?.origin).not.toContain('zoe');
  });
});

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  fiches: FicheClient;
  unique: FicheUnique;
  envoi: DecisionEnvoi;
  net: string;
  shawez: string;
  other: string;
  reprise: RepriseSite;
}

function snapshot(raw: SqliteDatabase): string {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}"`).all()]));
}

describeWithSqlite('reprise des fichiers des outils', () => {
  let w: World;
  beforeEach(async () => {
    const raw = openMemoryDatabase();
    const db = fromSyncSqlite(raw);
    await applyMigrations(db, loadMigrations());
    const now = (): Date => NOW;
    const fiches = new FicheClient(db, { now });
    const unique = new FicheUnique(db, fiches, { now });
    const envoi = new DecisionEnvoi(db, fiches, unique, { now });
    const net = (await fiches.createNetwork('Réseau test')).id;
    const shawez = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Principal' })).id;
    const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Autre' })).id;
    const reprise = new RepriseSite(db, fiches, unique, envoi, new SqlJournalStore(db), { networkId: net, agentId: shawez, actor: 'reprise:test', now });
    w = { raw, db, fiches, unique, envoi, net, shawez, other, reprise };
  });

  it('[R02] une personne de la liste d\'exclusion, retrouvée par mail ou téléphone, est exclue sur toutes ses fiches', async () => {
    // Deux fiches de la même personne, suivies par deux agents : elles restent à part, toutes deux exclues.
    const a = await w.fiches.createPerson({ networkId: w.net, agentId: w.shawez, firstName: 'Hana' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.shawez, personId: a.id, kind: 'email', value: 'hana@example.org' });
    const b = await w.fiches.createPerson({ networkId: w.net, agentId: w.other, firstName: 'Hana' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.other, personId: b.id, kind: 'phone', value: '0610000042' });
    const reading = await readToolCsv('Email;Téléphone\nhana@example.org;06 10 00 00 42\n', 'exclusion_list', NOW);
    const report = await w.reprise.run(reading, 'exclusion_list');
    expect(report).toMatchObject({ apart: 1, exclusions: 2 });
    for (const id of [a.id, b.id]) {
      const decision = await w.envoi.decide(id, { channel: 'sms', kind: 'reply', at: NOW });
      expect(decision).toMatchObject({ allowed: false, rule: 'R02' });
      expect((await w.unique.view(id)).exclusions.map((e) => [e.reason, e.channel])).toEqual([['network_list', null]]);
    }
  });

  it('[R02] une personne de la liste encore inconnue reçoit sa fiche, exclue : son premier message sera reconnu', async () => {
    await w.reprise.run(await readToolCsv('Email\nnouveau@example.org\n', 'exclusion_list', NOW), 'exclusion_list');
    const [person] = await w.unique.findByIdentifier(w.net, 'email', 'nouveau@example.org');
    expect(person).toBeDefined();
    expect((await w.unique.view(person!.id)).exclusions.map((e) => e.reason)).toEqual(['network_list']);
    const keys = await w.db.all<{ person_id: string }>('SELECT person_id FROM contact_keys');
    expect(keys.map((k) => k.person_id)).toEqual([person!.id]);
  });

  it('[R04] un désabonné de GoHighLevel ou de ManyChat est exclu sur tous les canaux', async () => {
    await w.reprise.run(await readToolCsv('Contact Id,Email,DND\ng1,ines@example.org,true\ng2,jo@example.org,false\n', 'gohighlevel', NOW), 'gohighlevel');
    await w.reprise.run(await readToolCsv('User ID;Instagram Username;Subscribed\nm1;kim.exemple;no\n', 'manychat', NOW), 'manychat');
    const [ines] = await w.unique.findByIdentifier(w.net, 'email', 'ines@example.org');
    const [jo] = await w.unique.findByIdentifier(w.net, 'email', 'jo@example.org');
    const [kim] = await w.unique.findByIdentifier(w.net, 'instagram', 'kim.exemple');
    for (const [person, channel] of [[ines, 'email'], [kim, 'instagram']] as const) {
      expect(await w.envoi.decide(person!.id, { channel, kind: 'reply', at: NOW })).toMatchObject({ allowed: false, rule: 'R04' });
      expect(await w.envoi.decide(person!.id, { channel: 'whatsapp', kind: 'reply', at: NOW })).toMatchObject({ allowed: false, rule: 'R04' });
    }
    expect((await w.unique.view(jo!.id)).exclusions).toEqual([]);
  });

  it('[R03] aucun accord n\'est repris des outils', async () => {
    await w.reprise.run(await readToolCsv('Contact Id,Email,Phone,DND\ng1,lea@example.org,0610000077,false\n', 'gohighlevel', NOW), 'gohighlevel');
    expect(await w.db.all('SELECT * FROM consents')).toEqual([]);
    const [lea] = await w.unique.findByIdentifier(w.net, 'email', 'lea@example.org');
    expect(await w.envoi.decide(lea!.id, { channel: 'email', kind: 'prospecting', at: NOW })).toMatchObject({ allowed: false, rule: 'R03' });
    expect((await w.unique.view(lea!.id)).sources.map((s) => s.channel)).toEqual(['gohighlevel']);
  });

  it('[R17] relancer les mêmes fichiers ne double rien et n\'écrit rien', async () => {
    const files = [
      ['Email;Téléphone\nmo@example.org;0610000088\n', 'exclusion_list'],
      ['Contact Id,Email,DND\ng9,mo@example.org,true\n', 'gohighlevel'],
    ] as const;
    for (const [csv, tool] of files) await w.reprise.run(await readToolCsv(csv, tool, NOW), tool);
    const before = snapshot(w.raw);
    for (const [csv, tool] of files) await w.reprise.run(await readToolCsv(csv, tool, NOW), tool);
    expect(snapshot(w.raw)).toBe(before);
    const [mo] = await w.unique.findByIdentifier(w.net, 'email', 'mo@example.org');
    expect((await w.unique.view(mo!.id)).exclusions.map((e) => e.reason).sort()).toEqual(['network_list', 'stop']);
  });
});

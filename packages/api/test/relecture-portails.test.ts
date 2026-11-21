import { expect, it } from 'vitest';
import { SqlJournalStore, annonces } from '@aimmo/core';
import { PORTAL_CHECK_JOB, portalCheckJob, runScheduler } from '../src/planificateur.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// AU068 · Portail, page et annonce inventés.
const URL_SL = 'https://www.seloger.com/annonces/achat/appartement/dijon-21/au068-api.htm';

describeWithSqlite('AU068 · la relecture des portails au planificateur', () => {
  it('[R473] le passage relit chaque annonce acceptée par le lecteur réel ; sans lecteur, il ne passe pas', async () => {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    const d = new annonces.DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now });
    expect(await d.setPortal(t.direction, { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['prix'], minPhotos: 0 })).toEqual({ ok: true });
    expect(await d.choose(t.agent, t.propertyId, 'seloger', true)).toEqual({ ok: true });
    const { seq } = (await t.db.first<{ seq: number }>('SELECT seq FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [t.propertyId]))!;
    await d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl: URL_SL });
    const reads: string[] = [];
    const reader = new annonces.HttpListingReader(async (url) => {
      reads.push(url);
      return { status: 410, headers: { get: () => 'text/html' }, text: async () => '' };
    });
    const job = portalCheckJob(t.db, new SqlJournalStore(t.db), reader, { now: t.now });
    expect([job.name, job.hours]).toEqual([PORTAL_CHECK_JOB, [7, 12, 18]]);
    await job.run({} as Parameters<typeof job.run>[0]);
    expect(reads).toEqual([URL_SL]);
    expect((await t.db.all<{ outcome: string }>('SELECT outcome FROM diffusion_portal_checks')).map((r) => r.outcome)).toEqual(['introuvable']);
    // À 7 h, sans lecteur réglé : la relecture n'est pas au programme.
    t.setClock(new Date('2027-03-02T07:00:00.000Z'));
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(tick?.ran ?? []).not.toContain(PORTAL_CHECK_JOB);
    expect(reads).toHaveLength(1);
  });
});

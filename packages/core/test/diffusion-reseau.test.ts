import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite } from '../src/index.ts';
import { Diffusion } from '../src/documents/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU106 · Mandats inventés, dans tous les états que la porte de la diffusion distingue.
const NOW = new Date('2027-03-02T09:00:00.000Z');

describeWithSqlite('AU106 · la porte de la diffusion lue pour tout le réseau d’un coup', () => {
  it('[R42] mêmes réponses que bien par bien : en cours, échu, prolongé par avenant, rétracté, annulé, en délai, commencé tôt, sans numéro', async () => {
    const raw = openMemoryDatabase();
    const db = fromSyncSqlite(raw);
    await applyMigrations(db, loadMigrations());
    const now = () => NOW;
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
    const diffusion = new Diffusion(db, acces, journal, { now });
    const at = '2026-01-01T08:00:00.000Z';
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.prepare("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', ?), ('net-2', 'Autre réseau', ?)").run(at, at);
    const seqs: Record<string, number> = {};
    const mandate = (key: string, o: { signedAt: string; place?: string; months?: number; number?: string | null; network?: string }) => {
      const net = o.network ?? 'net-1';
      raw.prepare("INSERT INTO properties (id, network_id, agent_id, reference, kind, status, created_at, updated_at) VALUES (?, ?, NULL, ?, 'home', 'available', ?, ?)").run(`b-${key}`, net, `REF-${key}`, at, at);
      raw.prepare("INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES (?, ?, 'a', 'p', NULL, ?, ?, 'site', NULL, NULL, 'x', ?)").run(`m-${key}`, net, `b-${key}`, o.signedAt, o.signedAt);
      raw.prepare("INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, facts, created_by, created_at) VALUES (?, ?, 't', 1, 'h', 'mandat_vente_simple', 'reel', 'complet', '[]', 'a', 'p', ?, 'x', 'h', ?, 'agent', ?)").run(`d-${key}`, net, `b-${key}`, JSON.stringify({ durationMonths: o.months ?? 12 }), o.signedAt);
      const number = o.number === undefined ? `T-${key}` : o.number;
      raw.prepare("INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, mandate_id, number, copy_content, copy_hash, registered_by, created_at) VALUES (?, ?, ?, ?, 's', ?, ?, 'exemplaire', 'h', 'agent', ?)").run(`d-${key}`, net, o.signedAt, o.place ?? 'agence', `m-${key}`, number, o.signedAt);
      const seq = (seqs[net] = (seqs[net] ?? 0) + 1);
      raw.prepare("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, 'a', ?, ?, ?, 'test', 'p', ?)").run(net, seq, `m-${key}`, seq, `T-${key}`, `b-${key}`, o.signedAt, o.signedAt, `h-${key}`);
      return seq;
    };
    mandate('en-cours', { signedAt: '2026-06-01T09:00:00.000Z' });
    mandate('echu', { signedAt: '2025-06-01T09:00:00.000Z', months: 6 });
    mandate('prolonge', { signedAt: '2025-06-01T09:00:00.000Z', months: 6 });
    raw.prepare("INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, facts, created_by, created_at) VALUES ('av-1', 'net-1', 't', 1, 'h', 'avenant', 'reel', 'complet', '[]', 'a', 'p', 'b-prolonge', 'x', 'h', ?, 'agent', ?)").run(JSON.stringify({ durationMonths: 24 }), '2025-11-01T09:00:00.000Z');
    raw.prepare("INSERT INTO signed_amendments (document_id, network_id, mandate_id, signed_at, place, scan_ref, copy_content, copy_hash, registered_by, created_at) VALUES ('av-1', 'net-1', 'm-prolonge', '2025-11-01T09:00:00.000Z', 'agence', 's', 'x', 'h', 'agent', '2025-11-01T09:00:00.000Z')").run();
    mandate('retracte', { signedAt: '2026-06-01T09:00:00.000Z', place: 'hors_agence' });
    raw.prepare("INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES ('m-retracte', 'net-1', 'courrier test', '2026-06-05T09:00:00.000Z', 'a', '2026-06-05T09:00:00.000Z')").run();
    const cancelled = mandate('annule', { signedAt: '2026-06-01T09:00:00.000Z' });
    const seq = (seqs['net-1'] = seqs['net-1']! + 1);
    raw.prepare("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash, cancels_seq, reason) VALUES ('net-1', ?, 'annulation', 'm-annule', ?, 'T-annule', 'a', 'b-annule', '2026-06-01T09:00:00.000Z', '2026-06-02T09:00:00.000Z', 'test', 'p', 'h-ann', ?, 'error')").run(seq, seq, cancelled);
    mandate('en-delai', { signedAt: '2027-02-27T09:00:00.000Z', place: 'distance' });
    mandate('tot', { signedAt: '2027-02-27T09:00:00.000Z', place: 'hors_agence' });
    raw.prepare("INSERT INTO mandate_early_starts (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES ('m-tot', 'net-1', 'demande écrite test', '2027-02-28T09:00:00.000Z', 'a', '2027-02-28T09:00:00.000Z')").run();
    mandate('sans-numero', { signedAt: '2026-06-01T09:00:00.000Z', number: null });
    mandate('futur', { signedAt: '2027-04-01T09:00:00.000Z' });
    mandate('ailleurs', { signedAt: '2026-06-01T09:00:00.000Z', network: 'net-2' });
    raw.exec('PRAGMA foreign_keys = ON');

    const open = await diffusion.diffusableProperties('net-1', NOW);
    const ids = (raw.prepare("SELECT id FROM properties WHERE network_id = 'net-1' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    for (const id of ids) expect(open.has(id), id).toBe((await diffusion.canDiffuse('net-1', id, NOW)).allowed);
    expect([...open].sort()).toEqual(['b-en-cours', 'b-prolonge', 'b-tot']);
    // Un bien d'un autre réseau n'y est jamais.
    expect(open.has('b-ailleurs')).toBe(false);
  });
});

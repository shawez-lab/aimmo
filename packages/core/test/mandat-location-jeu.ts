import type { SqlDatabase } from '../src/index.ts';

// AU014 · Un mandat de location inventé, signé à l'agence, inscrit au registre : ce que la location demande avant
// toute annonce publiable ou tout barème d'honoraires. Écrit ligne à ligne, comme le ferait la signature.
let n = 0;
export async function signRentalMandate(
  db: SqlDatabase,
  o: { networkId: string; agentId: string; personId: string; propertyId: string; signedAt?: string; months?: number; kind?: 'mandat_location' | 'mandat_vente_simple' },
): Promise<string> {
  const id = `loc-${++n}-${o.propertyId}`;
  const at = o.signedAt ?? '2026-01-05T09:00:00.000Z';
  const kind = o.kind ?? 'mandat_location';
  const template = await db.first<{ id: string }>('SELECT id FROM document_templates WHERE network_id = ? AND kind = ? LIMIT 1', [o.networkId, kind]);
  const templateId = template?.id ?? `tpl-${id}`;
  if (!template) {
    await db.run("INSERT INTO document_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at) VALUES (?, ?, ?, 1, 'essai', 'x', '[]', 'h', 'test', ?)", [templateId, o.networkId, kind, at]);
  }
  await db.run(
    `INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, facts, created_by, created_at)
     VALUES (?, ?, ?, 1, 'h', ?, 'reel', 'complet', '[]', ?, ?, ?, 'mandat', 'h', ?, 'test', ?)`,
    [`d-${id}`, o.networkId, templateId, kind, o.agentId, o.personId, o.propertyId, JSON.stringify({ priceEur: null, feeEur: 500, feeCharge: null, durationMonths: o.months ?? 36 }), at],
  );
  await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'site', NULL, NULL, 'test', ?)", [
    `m-${id}`,
    o.networkId,
    o.agentId,
    o.personId,
    o.propertyId,
    at,
    at,
  ]);
  const seq = Number((await db.first<{ s: number | null }>('SELECT MAX(seq) AS s FROM mandate_register WHERE network_id = ?', [o.networkId]))?.s ?? 0) + 1;
  await db.run(
    "INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, mandate_id, number, copy_content, copy_hash, registered_by, created_at) VALUES (?, ?, ?, 'agence', ?, ?, ?, 'exemplaire', 'h', 'test', ?)",
    [`d-${id}`, o.networkId, at, `scan-${id}`, `m-${id}`, `L-${seq}`, at],
  );
  await db.run(
    "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, ?, 'test', 'p', ?)",
    [o.networkId, seq, `m-${id}`, 100000 + seq, `L-${seq}`, o.agentId, o.propertyId, at, at, `h-${id}`],
  );
  return `m-${id}`;
}

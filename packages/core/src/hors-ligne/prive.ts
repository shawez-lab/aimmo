/**
 * AU104 · Le mode privé de la visite (HX12) [R676, R278].
 *
 * Le paquet du jour ne porte rien d'un client [R278] : en zone blanche, l'agent ne retrouvait ni l'entrée ni son
 * contact. Le mode privé lui donne, sur son geste et pour ses seules visites et estimations du jour encore à venir ou en
 * cours, ce qu'il faut pour arriver et appeler : l'adresse du bien, le nom et un numéro de la personne rencontrée.
 * Jamais son mail, jamais rien d'autre, jamais le vendeur d'une visite.
 *
 * Chaque visite porte l'heure où le téléphone l'efface, deux heures après sa fin, et jamais après minuit à Paris. Le
 * téléphone chiffre le tout sous un code de l'agent qui ne quitte jamais l'appareil (voir `app/hors-ligne.ts`).
 * Ce fichier n'écrit rien : la lecture va au journal dans `HorsLigne.privatePack`, sans aucune donnée.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { latestDesignation } from '../documents/designation.ts';

/** Une visite s'efface du téléphone tant de temps après sa fin. */
export const PRIVATE_KEEP_AFTER_END_MS = 2 * 3_600_000;
/** Le code qui ferme le mode privé : des chiffres, au moins tant. */
export const PRIVATE_CODE_MIN_DIGITS = 6;
/** Après tant de codes faux, le téléphone efface le mode privé. */
export const PRIVATE_MAX_TRIES = 5;
/** Sans geste pendant tant de temps, le mode privé se referme. */
export const PRIVATE_IDLE_LOCK_MS = 5 * 60_000;

export interface PrivateVisit {
  appointmentId: string;
  /** L'adresse du bien, telle que rangée dans sa désignation, ou reprise de l'ancien logiciel ; null si aucune. */
  address: { street: string; postalCode: string; city: string } | null;
  /** La personne rencontrée : son nom et un numéro, jamais son mail. */
  contact: { name: string | null; phone: string | null };
  /** Après cette heure, le téléphone efface cette visite. */
  wipeAt: string;
}

export interface PrivatePack {
  day: string;
  /** Après cette heure, le téléphone efface tout le mode privé. */
  validUntil: string;
  visits: PrivateVisit[];
}

interface Row {
  id: string;
  person_id: string;
  property_id: string | null;
  end_at: string;
}

/** L'adresse du bien : sa désignation la plus récente, sinon l'adresse reprise de l'ancien logiciel (AU031). */
async function propertyAddress(db: SqlDatabase, networkId: string, propertyId: string | null): Promise<PrivateVisit['address']> {
  if (!propertyId) return null;
  const d = await latestDesignation(db, networkId, propertyId);
  if (d) return { street: d.address.street, postalCode: d.address.postalCode, city: d.address.city };
  const r = await db.first<{ street: string; postal_code: string; city: string }>(
    'SELECT street, postal_code, city FROM agent_import_property_addresses WHERE network_id = ? AND property_id = ?',
    [networkId, propertyId],
  );
  return r ? { street: r.street, postalCode: r.postal_code, city: r.city } : null;
}

/**
 * La personne rencontrée, avec les fiches réunies en la sienne ou en qui elle a été réunie (S04) : le nom de sa fiche,
 * sinon celui de la fiche gardée, et le premier numéro rangé. Le mail n'est jamais lu.
 */
async function contactOf(db: SqlDatabase, networkId: string, personId: string): Promise<PrivateVisit['contact']> {
  const family = await db.all<{ id: string; first_name: string | null; last_name: string | null; own: number }>(
    `WITH RECURSIVE fam(id) AS (
       SELECT ?
       UNION
       SELECT CASE WHEN m.survivor_id = fam.id THEN m.merged_id ELSE m.survivor_id END
         FROM person_merges m JOIN fam ON (m.survivor_id = fam.id OR m.merged_id = fam.id)
        WHERE m.network_id = ? AND m.undone_at IS NULL
     )
     SELECT p.id, p.first_name, p.last_name, CASE WHEN p.id = ? THEN 1 ELSE 0 END AS own
       FROM persons p JOIN fam ON fam.id = p.id WHERE p.network_id = ? ORDER BY own DESC, p.created_at, p.id`,
    [personId, networkId, personId, networkId],
  );
  const named = family.find((p) => (p.first_name ?? '').trim() || (p.last_name ?? '').trim());
  const name = named ? [named.first_name, named.last_name].map((x) => (x ?? '').trim()).filter(Boolean).join(' ') : null;
  if (family.length === 0) return { name: null, phone: null };
  const ids = family.map((p) => p.id);
  const phone = await db.first<{ value: string }>(
    `SELECT value FROM person_identifiers WHERE network_id = ? AND kind = 'phone' AND person_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY CASE WHEN person_id = ? THEN 0 ELSE 1 END, created_at, id LIMIT 1`,
    [networkId, ...ids, personId],
  );
  return { name, phone: phone?.value ?? null };
}

/**
 * Les visites et estimations prévues de l'agent, commencées le jour de Paris `day`, dont la fin plus deux heures n'est
 * pas passée : seules celles-là entrent au mode privé [R676].
 */
export async function privateVisits(db: SqlDatabase, networkId: string, agentId: string, from: Date, next: Date, now: Date): Promise<PrivateVisit[]> {
  const rows = await db.all<Row>(
    `SELECT id, person_id, property_id, end_at FROM appointments
      WHERE network_id = ? AND agent_id = ? AND status = 'booked' AND kind IN ('visite', 'estimation') AND start_at >= ? AND start_at < ?
      ORDER BY start_at, id`,
    [networkId, agentId, from.toISOString(), next.toISOString()],
  );
  const out: PrivateVisit[] = [];
  for (const r of rows) {
    const wipe = Math.min(Date.parse(r.end_at) + PRIVATE_KEEP_AFTER_END_MS, next.getTime());
    if (!(wipe > now.getTime())) continue;
    out.push({
      appointmentId: r.id,
      address: await propertyAddress(db, networkId, r.property_id),
      contact: await contactOf(db, networkId, r.person_id),
      wipeAt: new Date(wipe).toISOString(),
    });
  }
  return out;
}

/**
 * L'adresse professionnelle d'un partenaire de l'annuaire, pour les relances des demandes confiées (U12) [R03, R16, R17].
 *
 * La direction la range avec l'accord que le partenaire a donné de recevoir par mail le suivi des demandes qui lui
 * sont confiées : la date est celle du rangement, la preuve une note (« accord écrit dans la convention du 12 mars »).
 * Sans adresse rangée, aucune relance ne part : le contrôle central la laisse en attente. Une opposition reçue de
 * cette adresse, par le lien ou rangée par la direction, l'emporte toujours [R04].
 *
 * Une nouvelle version s'ajoute, rien ne change ni ne s'efface [R17] ; le journal ne garde jamais l'adresse [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export type AdresseRefusal = { ok: false; rule: 'R16' | 'R04' | null; code: string };
export type AdresseResult<T> = { ok: true; value: T } | AdresseRefusal;

export interface PartnerAddress {
  partnerId: string;
  version: number;
  recordedAt: string;
}

export class AdressesPartenaires {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Range l'adresse professionnelle et l'accord du partenaire ; la direction seule [R16, R03]. */
  async record(viewer: Viewer, partnerId: unknown, input: { email: unknown; consentProof: unknown }): Promise<AdresseResult<PartnerAddress>> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `partner:${String(partnerId)}`, data: { rule: 'R16', role: String(viewer.role), kind: 'partner_address' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof partnerId !== 'string') return { ok: false, rule: null, code: 'unknown' };
    const partner = await this.db.first('SELECT 1 FROM partners WHERE id = ? AND network_id = ?', [partnerId, viewer.networkId]);
    if (!partner) return { ok: false, rule: null, code: 'unknown' };
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) return { ok: false, rule: null, code: 'bad_email' };
    const proof = typeof input.consentProof === 'string' ? input.consentProof.trim() : '';
    if (proof.length < 3 || proof.length > 500) return { ok: false, rule: null, code: 'bad_proof' };
    // Un partenaire qui a demandé l'arrêt ne reçoit plus rien : une nouvelle adresse ne le rouvre pas [R04].
    const opposed = await this.db.first(
      'SELECT 1 FROM partner_prospect_optouts o WHERE o.network_id = ? AND (o.email = ? OR o.email IN (SELECT a.email FROM partner_addresses a WHERE a.network_id = ? AND a.partner_id = ?))',
      [viewer.networkId, email, viewer.networkId, partnerId],
    );
    if (opposed) return { ok: false, rule: 'R04', code: 'opposed' };
    const at = this.now().toISOString();
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM partner_addresses WHERE partner_id = ?', [partnerId]);
      const version = Number(last?.v ?? 0) + 1;
      try {
        await this.db.run(
          'INSERT INTO partner_addresses (id, network_id, partner_id, version, email, consent_proof, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [this.newId(), viewer.networkId, partnerId, version, email, proof, actor, at],
        );
      } catch (error) {
        // Deux rangements ensemble : la version suivante est reprise.
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      await appendEvent(this.journal, { type: 'partenaire.adresse_rangee', actor, subject: `partner:${partnerId}`, data: { rule: 'R03', version } }, this.now);
      return { ok: true, value: { partnerId, version, recordedAt: at } };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /**
   * La direction range l'opposition d'un partenaire (réponse, appel) : son adresse ne reçoit plus rien, sur aucun canal,
   * prospection comprise, pour toujours [R04, R02]. Toutes ses adresses rangées sont opposées.
   */
  async oppose(viewer: Viewer, partnerId: unknown): Promise<AdresseResult<number>> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `partner:${String(partnerId)}`, data: { rule: 'R16', role: String(viewer.role), kind: 'partner_address' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof partnerId !== 'string') return { ok: false, rule: null, code: 'unknown' };
    const rows = await this.db.all<{ email: string }>('SELECT DISTINCT email FROM partner_addresses WHERE network_id = ? AND partner_id = ?', [viewer.networkId, partnerId]);
    if (rows.length === 0) return { ok: false, rule: null, code: 'unknown' };
    const at = this.now().toISOString();
    let added = 0;
    for (const r of rows) {
      const w = await this.db.run("INSERT INTO partner_prospect_optouts (network_id, email, via, at) VALUES (?, ?, 'agent', ?) ON CONFLICT DO NOTHING", [viewer.networkId, r.email, at]);
      added += w.changes;
    }
    await appendEvent(this.journal, { type: 'partenaire.opposition', actor, subject: `partner:${partnerId}`, data: { rule: 'R04', added } }, this.now);
    return { ok: true, value: added };
  }
}

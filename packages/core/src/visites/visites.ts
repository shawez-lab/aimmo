/**
 * Visites et bon de visite (M08, T04). Une visite est un rendez-vous de V02 (`kind = 'visite'`) relié à un bien et au
 * projet d'achat d'un acquéreur. Le bien doit pouvoir être diffusé [R42]. Le bon de visite est rempli depuis la base
 * selon un modèle daté et versionné, gardé avec lui ; un champ absent le laisse « incomplet », jamais un texte inventé
 * [R40]. Aucune adresse exacte n'y figure, ni dans la confirmation au visiteur [R19]. Une visite annulée garde son bon
 * [R17]. Le rappel de la veille est celui de V04, pour tout rendez-vous.
 *
 * Décidé, lecture prudente : la bibliothèque de D02 n'admet que les types de mandat (contrainte de sa table, qu'il
 * faudrait reconstruire) ; le bon de visite a ses propres modèles, aux mêmes règles : versions figées, créées par la
 * direction, validées par la conformité seule ; tant qu'aucune version n'est validée (H08), le bon est d'essai. La
 * signature se range sur papier (date et scan) ; la signature en ligne de D08 viendra pour le bon avec H24.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { DiffusionGate } from '../acquereurs/rapprochement.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { OutboundChannelName, Project } from '../db/types.ts';
import { Diffusion } from '../documents/retractation.ts';
import { renderDocument, sha256, templateFields, type FieldSource } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RendezVous, type Appointment, type BookingRefusal } from '../rendezvous/reservation.ts';

const TIME_ZONE = 'Europe/Paris';

/** Les champs d'un bon de visite : rien qui situe le bien plus précisément que sa commune [R19]. */
export const VISIT_SLIP_FIELDS: Readonly<Record<string, { source: FieldSource; label: string }>> = Object.freeze({
  'visiteur.nom': { source: 'base', label: 'nom du visiteur' },
  'bien.reference': { source: 'base', label: 'référence du bien' },
  'bien.type': { source: 'base', label: 'type de bien' },
  'bien.commune': { source: 'base', label: 'commune du bien' },
  'bien.surface': { source: 'base', label: 'surface du bien' },
  'bien.pieces': { source: 'base', label: 'nombre de pièces' },
  'bien.prix': { source: 'base', label: 'prix du bien' },
  'visite.date': { source: 'base', label: 'date de la visite' },
  'visite.heure': { source: 'base', label: 'heure de la visite' },
  'agent.nom': { source: 'base', label: 'nom de l’agent' },
  'reseau.nom': { source: 'base', label: 'nom du réseau' },
  'signature.date': { source: 'signature', label: 'date de signature' },
});

/** Un bon de visite porte au moins le bien, la date et le visiteur. */
const REQUIRED_FIELDS = ['visiteur.nom', 'bien.reference', 'visite.date'];

const PROPERTY_KIND: Record<string, string> = {
  home: 'logement',
  land: 'terrain',
  building: 'immeuble',
  commercial: 'local professionnel',
  business_walls: 'murs commerciaux',
  business: 'fonds de commerce',
};
const number = new Intl.NumberFormat('fr-FR');
const fmt = (n: number): string => number.format(n).replace(/ | /g, ' ');

export type VisitRefusal = { ok: false; rule: string | null; code: string };

export interface VisitSlip {
  id: string;
  appointmentId: string;
  templateVersion: number;
  mode: 'essai' | 'reel';
  status: 'complet' | 'incomplet';
  missing: string[];
  content: string;
  contentHash: string;
  signedAt: string | null;
}

export interface ScheduledVisit {
  appointment: Appointment;
  slip: VisitSlip;
  confirmation: { status: string; rule: string | null } | null;
}

export interface VisitesOptions {
  diffusion?: DiffusionGate;
  rendezVous?: RendezVous;
  now?: () => Date;
  newId?: () => string;
}

interface TemplateRow {
  id: string;
  version: number;
  status: 'essai' | 'valide';
  body: string;
  fields: string;
  hash: string;
}

type SlipProperty = { id: string; reference: string; kind: string; postal_code: string | null; city: string | null; surface_m2: number | null; rooms: number | null; price_eur: number | null };

interface SlipRow {
  id: string;
  appointment_id: string;
  template_version: number;
  mode: 'essai' | 'reel';
  status: 'complet' | 'incomplet';
  missing: string;
  content: string;
  content_hash: string;
  signed_at: string | null;
}

const toSlip = (r: SlipRow): VisitSlip => ({
  id: r.id,
  appointmentId: r.appointment_id,
  templateVersion: Number(r.template_version),
  mode: r.mode,
  status: r.status,
  missing: JSON.parse(r.missing) as string[],
  content: r.content,
  contentHash: r.content_hash,
  signedAt: r.signed_at,
});

export class Visites {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly gate: DiffusionGate;
  private readonly rdv: RendezVous;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly acces: Acces,
    options: VisitesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.gate = options.diffusion ?? new Diffusion(db, acces, journal, { now: this.now });
    this.rdv = options.rendezVous ?? new RendezVous(db, journal, { now: this.now });
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string, subject: string | null = null): Promise<VisitRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Une nouvelle version du modèle de bon de visite, d'essai : par la direction seule. */
  async createSlipTemplate(viewer: Viewer, body: string): Promise<{ ok: true; id: string; version: number } | VisitRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'visit_slip_template', 'role');
    if (typeof body !== 'string' || body.trim() === '' || body.length > 20_000) return { ok: false, rule: null, code: 'bad_body' };
    const fields = templateFields(body);
    if (fields.some((f) => !VISIT_SLIP_FIELDS[f])) return { ok: false, rule: 'R40', code: 'unknown_field' };
    if (/\{\{|\}\}/.test(body.replace(/\{\{\s*[a-z_.]+\s*\}\}/g, ''))) return { ok: false, rule: 'R40', code: 'unknown_field' };
    if (REQUIRED_FIELDS.some((f) => !fields.includes(f))) return { ok: false, rule: 'R40', code: 'missing_required_field' };
    const hash = await sha256(JSON.stringify(['bon_de_visite', body, fields]));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM visit_slip_templates WHERE network_id = ?', [viewer.networkId]);
      const version = Number(last?.v ?? 0) + 1;
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO visit_slip_templates (id, network_id, version, status, body, fields, hash, created_by, created_at) VALUES (?, ?, ?, 'essai', ?, ?, ?, ?, ?)
         ON CONFLICT (network_id, version) DO NOTHING`,
        [id, viewer.networkId, version, body, JSON.stringify(fields), hash, this.actor(viewer), this.now().toISOString()],
      );
      if (changes === 1) {
        await appendEvent(this.journal, { type: 'bon_visite.modele', actor: this.actor(viewer), subject: `visit_template:${id}`, data: { version } }, this.now);
        return { ok: true, id, version };
      }
    }
    throw new Error('modèle de bon de visite : trop d’écritures simultanées');
  }

  /** La validation d'une version : par la conformité seule, jamais par le code. */
  async validateSlipTemplate(viewer: Viewer, templateId: string): Promise<{ ok: true } | VisitRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'visit_slip_template', 'role');
    const { changes } = await this.db.run(
      `UPDATE visit_slip_templates SET status = 'valide', validated_by = ?, validated_at = ? WHERE id = ? AND network_id = ? AND status = 'essai'`,
      [this.actor(viewer), this.now().toISOString(), templateId, viewer.networkId],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'unknown_template' };
    await appendEvent(this.journal, { type: 'bon_visite.modele_valide', actor: this.actor(viewer), subject: `visit_template:${templateId}`, data: {} }, this.now);
    return { ok: true };
  }

  /**
   * Fixe une visite pour un acquéreur et un bien diffusable, et produit son bon de visite. L'agent qui suit
   * l'acquéreur, ou la direction ; le bien peut être celui d'un autre agent (fichier commun) [R16].
   */
  async schedule(
    viewer: Viewer,
    request: { propertyId: string; projectId: string; start: Date; channel?: OutboundChannelName | null },
  ): Promise<{ ok: true; visit: ScheduledVisit } | VisitRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'visit', 'role');
    const project = await this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'buy'", [request.projectId, viewer.networkId]);
    if (!project) return this.refuse(viewer, 'visit', 'unknown', `project:${request.projectId}`);
    const fiche = await this.acces.readFiche(viewer, project.person_id);
    if (!fiche.ok) return { ok: false, rule: 'R16', code: fiche.code };
    if (fiche.view !== 'full') return this.refuse(viewer, 'person', 'not_assigned', `person:${project.person_id}`);
    const read = await this.acces.readProperty(viewer, request.propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    const property = read.value;
    const gate = await this.gate.canDiffuse(viewer.networkId, property.id, this.now());
    if (!gate.allowed) {
      await appendEvent(this.journal, { type: 'visite.refusee', actor: this.actor(viewer), subject: `property:${property.id}`, data: { rule: 'R42', code: gate.reason } }, this.now);
      return { ok: false, rule: 'R42', code: gate.reason };
    }
    // Sans modèle de bon de visite, aucune visite : le bon est exigé avec elle [R40].
    if (!(await this.currentTemplate(viewer.networkId))) return { ok: false, rule: 'R40', code: 'no_template' };
    const root = fiche.value.person;
    const agentId = viewer.role === 'agent' ? viewer.userId : (fiche.value.members.map((m) => m.agent_id).find((a) => a !== null) ?? null);
    if (!agentId) return { ok: false, rule: null, code: 'no_agent' };

    const booking = await this.rdv.book({
      networkId: viewer.networkId,
      agentId,
      personId: root.id,
      propertyId: property.id,
      kind: 'visite',
      start: request.start,
      source: 'agent',
      channel: request.channel ?? null,
    });
    if (!booking.ok) return { ok: false, rule: booking.rule, code: booking.code satisfies BookingRefusal };
    const appointment = booking.appointment;
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [appointment.id, viewer.networkId, property.id, project.id, root.id, agentId, this.actor(viewer), at],
    );
    await appendEvent(
      this.journal,
      { type: 'visite.fixee', actor: this.actor(viewer), subject: `person:${root.id}`, data: { appointment: appointment.id, property: property.id } },
      this.now,
    );
    const slip = await this.makeSlip(viewer.networkId, appointment, agentId, property, fiche.value.members);
    return { ok: true, visit: { appointment, slip, confirmation: booking.confirmation ? { status: booking.confirmation.status, rule: booking.confirmation.rule } : null } };
  }

  /** Le bon de visite d'une visite, pour l'agent qui l'a fixée ou la direction [R16]. */
  async slipOf(viewer: Viewer, appointmentId: string): Promise<{ ok: true; slip: VisitSlip } | VisitRefusal> {
    const visit = await this.visitFor(viewer, appointmentId);
    if (!visit.ok) return visit;
    const row = await this.ensureSlip(appointmentId);
    if (!row) return { ok: false, rule: null, code: 'no_slip' };
    return { ok: true, slip: toSlip(row) };
  }

  /** La signature sur papier du bon : la date et le scan, rangés une fois, sur un bon complet seulement [R40]. */
  async recordPaperSignature(viewer: Viewer, appointmentId: string, input: { signedAt: Date; scanRef: string }): Promise<{ ok: true; slip: VisitSlip } | VisitRefusal> {
    const visit = await this.visitFor(viewer, appointmentId);
    if (!visit.ok) return visit;
    const row = await this.ensureSlip(appointmentId);
    if (!row) return { ok: false, rule: null, code: 'no_slip' };
    if (row.status !== 'complet') return { ok: false, rule: 'R40', code: 'incomplete' };
    if (Number.isNaN(input.signedAt.getTime()) || input.signedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    if (typeof input.scanRef !== 'string' || input.scanRef.length < 1 || input.scanRef.length > 200) return { ok: false, rule: null, code: 'bad_scan' };
    const { changes } = await this.db.run('UPDATE visit_slips SET signed_at = ?, scan_ref = ?, signed_by = ? WHERE id = ? AND signed_at IS NULL', [
      input.signedAt.toISOString(),
      input.scanRef,
      this.actor(viewer),
      row.id,
    ]);
    if (changes === 1) {
      await appendEvent(this.journal, { type: 'bon_visite.signe', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { slip: row.id, mode: row.mode } }, this.now);
    }
    const after = await this.db.first<SlipRow>('SELECT * FROM visit_slips WHERE id = ?', [row.id]);
    return { ok: true, slip: toSlip(after!) };
  }

  /** L'agent annule la visite : le rendez-vous est annulé, la visite et son bon restent [R17]. */
  async cancel(viewer: Viewer, appointmentId: string): Promise<{ ok: true } | VisitRefusal> {
    const visit = await this.visitFor(viewer, appointmentId);
    if (!visit.ok) return visit;
    const r = await this.rdv.cancelAsAgent(viewer, appointmentId);
    if (!r.ok) return { ok: false, rule: r.code === 'not_agent' ? 'R16' : null, code: r.code };
    return { ok: true };
  }

  /**
   * La visite d'un rendez-vous, pour qui voit la fiche de l'acquéreur en entier aujourd'hui : la lecture passe par les
   * droits, qui l'écrivent au journal avant de rendre quoi que ce soit [R16]. Un rendez-vous qui en remplace un autre
   * (décalé par le lien ou par l'agenda) reprend la visite de celui qu'il remplace, avec un bon neuf à sa date.
   */
  private async visitFor(viewer: Viewer, appointmentId: string): Promise<{ ok: true; agentId: string } | VisitRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'visit', 'role', `visit:${appointmentId}`);
    const v = await this.visitRow(appointmentId);
    if (!v || v.network_id !== viewer.networkId) return this.refuse(viewer, 'visit', 'unknown', `visit:${appointmentId}`);
    const read = await this.acces.readFiche(viewer, v.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, 'visit', 'not_assigned', `visit:${appointmentId}`);
    return { ok: true, agentId: v.agent_id };
  }

  private async visitRow(appointmentId: string): Promise<{ network_id: string; agent_id: string; person_id: string } | null> {
    const direct = await this.db.first<{ network_id: string; agent_id: string; person_id: string }>('SELECT network_id, agent_id, person_id FROM visits WHERE appointment_id = ?', [appointmentId]);
    if (direct) return direct;
    // Remonter la suite des remplacements jusqu'à la visite d'origine.
    let id: string | null = appointmentId;
    for (let depth = 0; id !== null && depth < 20; depth += 1) {
      const appt: { replaces_id: string | null } | null = await this.db.first<{ replaces_id: string | null }>('SELECT replaces_id FROM appointments WHERE id = ?', [id]);
      id = appt?.replaces_id ?? null;
      if (id === null) return null;
      const origin = await this.db.first<{ network_id: string; property_id: string; project_id: string; person_id: string; agent_id: string }>(
        'SELECT network_id, property_id, project_id, person_id, agent_id FROM visits WHERE appointment_id = ?',
        [id],
      );
      if (!origin) continue;
      const appointment = await this.rdv.get(appointmentId);
      if (!appointment || appointment.network_id !== origin.network_id) return null;
      // Le bien doit pouvoir être diffusé encore pour qu'une visite décalée soit reprise ; l'ancienne garde son bon [R42].
      const gate = await this.gate.canDiffuse(origin.network_id, origin.property_id, this.now());
      if (!gate.allowed) {
        await appendEvent(this.journal, { type: 'visite.refusee', actor: 'system:visites', subject: `property:${origin.property_id}`, data: { rule: 'R42', code: gate.reason } }, this.now);
        return null;
      }
      await this.db.run(
        `INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'system:visites', ?) ON CONFLICT DO NOTHING`,
        [appointmentId, origin.network_id, origin.property_id, origin.project_id, origin.person_id, appointment.agent_id, this.now().toISOString()],
      );
      return { network_id: origin.network_id, agent_id: appointment.agent_id, person_id: origin.person_id };
    }
    return null;
  }

  /**
   * Le bon d'une visite ; s'il manque (une panne après l'enregistrement de la visite), il est refait, une seule fois
   * même en cas d'appels simultanés.
   */
  private async ensureSlip(appointmentId: string): Promise<SlipRow | null> {
    const row = await this.db.first<SlipRow>('SELECT * FROM visit_slips WHERE appointment_id = ?', [appointmentId]);
    if (row) return row;
    const v = await this.db.first<{ network_id: string; property_id: string; person_id: string; agent_id: string }>(
      'SELECT network_id, property_id, person_id, agent_id FROM visits WHERE appointment_id = ?',
      [appointmentId],
    );
    const appointment = v ? await this.rdv.get(appointmentId) : null;
    const property = v ? await this.db.first<SlipProperty>('SELECT * FROM properties WHERE id = ?', [v.property_id]) : null;
    if (!v || !appointment || !property || !(await this.currentTemplate(v.network_id))) return null;
    await this.makeSlip(v.network_id, appointment, v.agent_id, property, (await this.fiche.view(v.person_id)).members);
    return this.db.first<SlipRow>('SELECT * FROM visit_slips WHERE appointment_id = ?', [appointmentId]);
  }

  /** Le modèle en vigueur : la dernière version validée ; sinon la dernière d'essai, qui ne donne qu'un bon d'essai. */
  private async currentTemplate(networkId: string): Promise<TemplateRow | null> {
    return (
      (await this.db.first<TemplateRow>("SELECT * FROM visit_slip_templates WHERE network_id = ? AND status = 'valide' ORDER BY version DESC LIMIT 1", [networkId])) ??
      (await this.db.first<TemplateRow>('SELECT * FROM visit_slip_templates WHERE network_id = ? ORDER BY version DESC LIMIT 1', [networkId]))
    );
  }

  /** Le bon de visite, depuis la base et le modèle en vigueur. */
  private async makeSlip(
    networkId: string,
    appointment: Appointment,
    agentId: string,
    property: SlipProperty,
    members: readonly { first_name: string | null; last_name: string | null }[],
  ): Promise<VisitSlip> {
    const template = await this.currentTemplate(networkId);
    if (!template) throw new VisitWithoutTemplate();
    const text = (v: string | null | undefined): string | null => (v === null || v === undefined || v.trim() === '' ? null : v.trim());
    // Le visiteur est nommé par son prénom et son nom : l'un sans l'autre ne suffit pas.
    const first = members.map((m) => text(m.first_name)).find((n) => n) ?? null;
    const last = members.map((m) => text(m.last_name)).find((n) => n) ?? null;
    const agent = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [agentId]);
    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [networkId]);
    const start = localTime(new Date(appointment.start_at), TIME_ZONE);
    const values: Record<string, string | null> = {
      'visiteur.nom': first && last ? `${first} ${last}` : null,
      'bien.reference': text(property.reference),
      'bien.type': text(PROPERTY_KIND[property.kind] ?? null),
      'bien.commune': text([property.postal_code, property.city].filter(Boolean).join(' ')),
      'bien.surface': property.surface_m2 === null ? null : `${fmt(property.surface_m2)} m²`,
      'bien.pieces': property.rooms === null ? null : String(property.rooms),
      'bien.prix': property.price_eur === null ? null : `${fmt(property.price_eur)} €`,
      'visite.date': `${start.date.slice(8, 10)}/${start.date.slice(5, 7)}/${start.date.slice(0, 4)}`,
      'visite.heure': `${String(Math.floor(start.minutes / 60)).padStart(2, '0')} h ${String(start.minutes % 60).padStart(2, '0')}`,
      'agent.nom': agent ? text(`${agent.first_name} ${agent.last_name}`) : null,
      'reseau.nom': text(network?.name),
    };
    const fields = JSON.parse(template.fields) as string[];
    const missing = fields.filter((f) => VISIT_SLIP_FIELDS[f]?.source !== 'signature' && (values[f] === null || values[f] === undefined));
    const mode = template.status === 'valide' ? 'reel' : 'essai';
    const content = renderDocument(template.body, values, { title: `Bon de visite · ${values['bien.reference'] ?? ''}`, trial: mode === 'essai', fields: VISIT_SLIP_FIELDS });
    const contentHash = await sha256(content);
    const id = this.newId();
    const status = missing.length === 0 ? 'complet' : 'incomplet';
    const { changes } = await this.db.run(
      `INSERT INTO visit_slips (id, appointment_id, network_id, template_id, template_version, template_hash, mode, status, missing, content, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (appointment_id) DO NOTHING`,
      [id, appointment.id, networkId, template.id, Number(template.version), template.hash, mode, status, JSON.stringify(missing), content, contentHash, this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'bon_visite.genere', actor: 'system:visites', subject: `visit:${appointment.id}`, data: { slip: id, mode, status, missing: missing.length } }, this.now);
    return { id, appointmentId: appointment.id, templateVersion: Number(template.version), mode, status, missing, content, contentHash, signedAt: null };
  }
}

/** Aucun modèle de bon de visite dans le réseau : la direction doit en créer un (H08 pour un modèle réel). */
export class VisitWithoutTemplate extends Error {
  constructor() {
    super('Aucun modèle de bon de visite dans le réseau.');
  }
}

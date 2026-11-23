/**
 * La création à la voix (HX06). En sortant d'une visite, l'agent dicte une minute : l'appli lit la dictée et remplit,
 * à côté de chaque champ, la phrase dite qui le porte [R260] : le contact, le bien, le rendez-vous, et pour une visite,
 * le compte rendu (T06) qui part au vendeur. L'agent valide d'un geste ; avant, rien n'est rangé [R261].
 *
 * La lecture ne range rien : ni fiche, ni bien, ni rendez-vous, ni compte rendu, et la dictée n'est jamais écrite au
 * journal [R13]. La validation relit la même dictée et refuse tout champ qu'elle n'y retrouve pas : l'agent peut retirer
 * un champ, jamais en ajouter ni en changer un (il corrigera ensuite par les écrans habituels). Seul l'agent qui dicte
 * valide, pour lui-même ; la même demande rejouée ne crée rien de plus.
 *
 * Un contact dont le téléphone ou le mail est déjà dans une fiche rejoint cette fiche, sans toucher à ses noms ; deux
 * fiches distinctes : rien n'est fait, l'agent tranche [R262]. Aucun message ne part au contact : ni accord déduit de la
 * dictée, ni confirmation du rendez-vous. Seul le compte rendu validé part au vendeur, par le contrôle central (T06).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { NouveauBien } from '../biens/nouveau-bien.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { IdentifierKind, PropertyKind } from '../db/types.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { AppointmentKind } from '../rendezvous/creneaux.ts';
import type { RendezVous } from '../rendezvous/reservation.ts';
import { withoutContactDetails } from '../captation/premiere-reponse.ts';
import { checkReport, redactNames, type ComptesRendus, type VisitReport } from '../visites/compte-rendu.ts';
import type { Visites } from '../visites/visites.ts';
import { DICTATION_KEYS, DICTATION_MAX_CHARS, fieldOf, readDictation, unproposedNames, type DictatedField, type DictatedKey, type DictationDraft, type DictationTarget } from './lecture.ts';

/** AU053 : l'agenda relié de l'agent n'a pas pu être lu (`AgendaUnavailableError` de l'API) : rien n'est réservé [R702]. */
const agendaDown = (error: unknown): boolean => error instanceof Error && error.name === 'AgendaUnavailableError';
const AGENDA_DOWN_REFUSAL = { rule: 'R702', code: 'agenda_indisponible' } as const;

/**
 * Ce qu'une validation a déjà rangé quand le créneau est pris entre la vérification et la réservation (RC22) : rien
 * n'est effacé, le refus le dit pour que l'agent ne redicte pas ce qui existe [R261].
 */
export interface DictationKept {
  personId: string | null;
  contact: 'created' | 'matched' | null;
  propertyId: string | null;
}

export type DictationRefusal = {
  ok: false;
  rule: string | null;
  code: string;
  keys?: string[];
  /** Ce qui est déjà rangé pour cette demande, s'il y a quelque chose. */
  kept?: DictationKept;
  /** Jusqu'à trois créneaux libres de la même sorte, les plus proches, jamais passés (instants ISO). */
  freeSlots?: string[];
};

export interface DicteeDeps {
  acces: Acces;
  store: FicheClient;
  fiche: FicheUnique;
  biens: NouveauBien;
  rendezVous: RendezVous;
  /** Pour une dictée après une visite : la visite et son compte rendu (T06). */
  visites?: Visites;
  comptes?: ComptesRendus;
}

export interface DicteeOptions {
  now?: () => Date;
  /** Les communes de la zone de l'agent ; absentes, celles du socle. */
  communes?: readonly string[];
}

/** Ce que l'agent garde de la lecture : les champs, par cible, et le compte rendu montré. */
export interface DictationValidation {
  /** Tiré par l'écran, une fois par dictée : la même demande rejouée ne crée rien de plus. */
  requestId: string;
  dictation: string;
  /** L'instant de la lecture montrée, rendu par `prepare` : la dictée est relue à ce même instant. */
  readAt: string;
  /** La visite dont l'agent sort, s'il y en a une. */
  appointmentId?: string | null;
  keep: Partial<Record<DictationTarget, readonly string[]>>;
  /** Le compte rendu de la visite tel que l'agent le valide. */
  report?: VisitReport | null;
}

export interface DictationOutcome {
  ok: true;
  personId: string | null;
  contact: 'created' | 'matched' | null;
  propertyId: string | null;
  appointmentId: string | null;
  report: { delivery: string; rule: string | null } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
/** Une lecture plus ancienne se refait : le jour dit et les créneaux ont pu changer. */
const READ_VALID_MS = 12 * 3_600_000;
/** Les créneaux proposés quand celui dicté est pris entre-temps. */
const PROPOSED_SLOTS = 3;

export class Dictee {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly deps: DicteeDeps,
    private readonly options: DicteeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private read(dictation: string, at: Date): DictationDraft {
    return readDictation(dictation, { now: at, ...(this.options.communes ? { communes: this.options.communes } : {}) });
  }

  /**
   * La dictée telle que le compte rendu la reçoit : sans les noms ni les coordonnées des contacts dictés, qui ne servent
   * pas l'avis de visite et ne sont encore dans aucune fiche que T06 saurait retirer [R15]. Les chiffres restent.
   */
  private forReport(dictation: string): string {
    const draft = this.read(dictation, this.now());
    const names = draft.fields.filter((f) => f.target === 'contact' && (f.key === 'firstName' || f.key === 'lastName')).map((f) => String(f.value));
    // Les noms qui suivent « Madame », « s'appelle »… même quand aucun n'est proposé (nom à particule, trois mots).
    return redactNames(withoutContactDetails(dictation), [...names, ...unproposedNames(dictation)]);
  }

  /** Seul un agent dicte, pour lui-même ; la direction ne crée rien en son nom. */
  private async gate(viewer: Viewer, dictation: unknown): Promise<DictationRefusal | null> {
    if (viewer.role !== 'agent') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'dictation', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof dictation !== 'string' || dictation.trim() === '' || dictation.length > DICTATION_MAX_CHARS) return { ok: false, rule: null, code: 'bad_dictation' };
    const agent = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [viewer.userId, viewer.networkId]);
    if (!agent) return { ok: false, rule: 'R16', code: 'unknown_agent' };
    return null;
  }

  /**
   * La lecture de la dictée, à montrer à l'agent : chaque champ avec sa phrase, et pour une visite le compte rendu de
   * l'IA. Rien n'est rangé [R261].
   */
  async prepare(viewer: Viewer, input: { dictation: string; appointmentId?: string | null }): Promise<{ ok: true; draft: DictationDraft; readAt: string; report: VisitReport | null } | DictationRefusal> {
    const refused = await this.gate(viewer, input.dictation);
    if (refused) return refused;
    let report: VisitReport | null = null;
    if (input.appointmentId) {
      if (!this.deps.comptes) return { ok: false, rule: null, code: 'no_visit_reports' };
      const preview = await this.deps.comptes.preview(viewer, input.appointmentId, this.forReport(input.dictation));
      if (!preview.ok) return preview;
      report = preview.report;
    }
    const at = this.now();
    // L'instant de la lecture revient avec la validation : « demain » ou « mardi » y disent le même jour [R260].
    return { ok: true, draft: this.read(input.dictation, at), readAt: at.toISOString(), report };
  }

  /** Les champs gardés, tous retrouvés dans la dictée relue, ou le refus qui nomme ceux qui n'y sont pas [R260]. */
  private kept(draft: DictationDraft, keep: DictationValidation['keep']): Map<DictationTarget, Map<DictatedKey, DictatedField>> | DictationRefusal {
    const out = new Map<DictationTarget, Map<DictatedKey, DictatedField>>();
    const missing: string[] = [];
    if (typeof keep !== 'object' || keep === null || Array.isArray(keep)) return { ok: false, rule: null, code: 'bad_request' };
    for (const [target, keys] of Object.entries(keep)) {
      if (!(target in DICTATION_KEYS)) return { ok: false, rule: null, code: 'bad_request' };
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) return { ok: false, rule: null, code: 'bad_request' };
      const t = target as DictationTarget;
      const fields = new Map<DictatedKey, DictatedField>();
      for (const key of new Set(keys as string[])) {
        const f = (DICTATION_KEYS[t] as readonly string[]).includes(key) ? fieldOf(draft, t, key as DictatedKey) : undefined;
        if (f) fields.set(f.key, f);
        else missing.push(`${t}.${key}`);
      }
      if (fields.size > 0) out.set(t, fields);
    }
    if (missing.length > 0) return { ok: false, rule: 'R260', code: 'not_dictated', keys: missing };
    return out;
  }

  /**
   * La validation d'un geste : relit la dictée, refuse tout champ qu'elle ne porte pas [R260], vérifie tout avant de
   * ranger quoi que ce soit, puis crée ou retrouve le contact, crée le bien, réserve le rendez-vous et valide le compte
   * rendu, qui part au vendeur par le contrôle central.
   */
  async validate(viewer: Viewer, input: DictationValidation): Promise<DictationOutcome | DictationRefusal> {
    const refused = await this.gate(viewer, input.dictation);
    if (refused) return refused;
    if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) return { ok: false, rule: null, code: 'bad_request' };
    const readAt = typeof input.readAt === 'string' ? new Date(input.readAt) : new Date(NaN);
    const now = this.now();
    if (Number.isNaN(readAt.getTime()) || readAt.getTime() > now.getTime() || now.getTime() - readAt.getTime() > READ_VALID_MS) return { ok: false, rule: null, code: 'stale_reading' };
    const draft = this.read(input.dictation, readAt);
    const kept = this.kept(draft, input.keep);
    if (!(kept instanceof Map)) return kept;
    const contact = kept.get('contact');
    const bien = kept.get('bien');
    const rdv = kept.get('rendezvous');
    const appointmentId = input.appointmentId ?? null;
    const report = input.report ?? null;
    if (!contact && !bien && !rdv && !report) return { ok: false, rule: null, code: 'nothing_kept' };

    // Tout se vérifie avant d'écrire : un refus ne laisse rien derrière lui.
    if (contact && contact.size === 1 && contact.has('project')) return { ok: false, rule: null, code: 'contact_without_identity' };
    if (bien) {
      const lacking = (['kind', 'postalCode', 'city', 'surfaceM2'] as const).filter((k) => !bien.has(k));
      if (lacking.length > 0) return { ok: false, rule: null, code: 'incomplete_property', keys: lacking.map((k) => `bien.${k}`) };
      if (!contact) return { ok: false, rule: null, code: 'property_without_owner' };
      if (contact.get('project')?.value === 'buy') return { ok: false, rule: null, code: 'property_of_buyer' };
    }
    if (rdv && !(rdv.has('start') && rdv.has('appointmentKind'))) return { ok: false, rule: null, code: 'incomplete_appointment', keys: ['rendezvous.start', 'rendezvous.appointmentKind'].filter((k) => !rdv.has(k.split('.')[1] as DictatedKey)) };
    let visitPerson: string | null = null;
    if (report !== null || appointmentId !== null) {
      if (appointmentId === null) return { ok: false, rule: null, code: 'report_without_visit' };
      if (!this.deps.visites || !this.deps.comptes) return { ok: false, rule: null, code: 'no_visit_reports' };
      const access = await this.deps.visites.accessVisit(viewer, appointmentId);
      if (!access.ok) return access;
      visitPerson = (await this.db.first<{ person_id: string }>('SELECT person_id FROM visits WHERE appointment_id = ?', [appointmentId]))?.person_id ?? null;
      if (report !== null) {
        // Le compte rendu ne porte que ce que la dictée dit : aucun chiffre ni offre qu'elle ne porte [R10, R260].
        const checked = checkReport(report, input.dictation);
        if (!checked.ok) return { ok: false, rule: checked.code === 'contact' ? 'R52' : 'R260', code: `report_${checked.code}` };
        // L'acquéreur nommé ou une coordonnée de sa fiche : refusé avant d'écrire quoi que ce soit [R52].
        const named = await this.deps.comptes.refusalFor(appointmentId, checked.report);
        if (named) return { ...named, code: `report_${named.code}` };
      }
    }
    if (rdv && !contact && visitPerson === null) return { ok: false, rule: null, code: 'appointment_without_person' };
    // Une visite passe par la prise de visite (bon de visite, bien diffusable, projet d'achat) : seule une contre-visite
    // du même bien, pour le même acquéreur, se dicte ; une autre se prend à l'écran des visites [R40, R42].
    let counterVisit: { property_id: string; project_id: string } | null = null;
    if (rdv?.get('appointmentKind')?.value === 'visite') {
      if (appointmentId === null || contact) return { ok: false, rule: null, code: 'visit_needs_listing' };
      counterVisit = await this.db.first<{ property_id: string; project_id: string }>('SELECT property_id, project_id FROM visits WHERE appointment_id = ?', [appointmentId]);
      if (!counterVisit) return { ok: false, rule: null, code: 'visit_needs_listing' };
    }

    // Le contact : retrouvé par son téléphone ou son mail, sinon créé sous l'identifiant de la demande.
    let personId: string | null = null;
    let contactState: DictationOutcome['contact'] = null;
    if (contact) {
      const found = await this.contactOf(viewer, input.requestId, contact);
      if (!found.ok) return found;
      personId = found.personId;
      contactState = found.state;
    } else if (rdv) personId = visitPerson;

    const start = rdv ? new Date(String(rdv.get('start')!.value)) : null;
    const kind = rdv ? (rdv.get('appointmentKind')!.value as AppointmentKind) : null;
    // Le créneau, vérifié avant de créer quoi que ce soit d'autre [R32, R33].
    if (start && kind && personId) {
      const existing = await this.bookedFor(viewer, personId, kind, start, bien ? input.requestId : (counterVisit?.property_id ?? null), counterVisit?.project_id ?? null);
      if (!existing) {
        let free: Awaited<ReturnType<RendezVous['freeSlotsFor']>>;
        try {
          free = await this.deps.rendezVous.freeSlotsFor(viewer.userId, kind, new Date(start.getTime() - DAY_MS), new Date(start.getTime() + DAY_MS));
        } catch (error) {
          // AU053 : l'agenda relié de l'agent injoignable : refusé avant d'écrire, en nommant ce qui est déjà rangé [R702].
          if (!agendaDown(error)) throw error;
          const earlier = await this.leftBy(viewer, input.requestId, personId, contactState);
          return { ok: false, rule: 'R702', code: 'agenda_indisponible', ...(earlier ? { kept: earlier } : {}) };
        }
        if (!free.some((s) => s.start.getTime() === start.getTime())) {
          // Rejouée après un créneau pris entre-temps : refusée avant d'écrire, en nommant ce qui est déjà rangé (RC22).
          const earlier = await this.leftBy(viewer, input.requestId, personId, contactState);
          return { ok: false, rule: 'R32', code: 'slot_not_free', ...(earlier ? { kept: earlier } : {}) };
        }
      }
    }

    // Les vérifications sont faites : la fiche est créée, ou la fiche retrouvée reçoit les coordonnées dictées.
    if (contact && contactState === 'created') await this.createContact(viewer, input.requestId, contact);
    if (contact && personId && contactState === 'matched') await this.attachIdentifiers(viewer, personId, contact);
    if (contact && personId) await this.openProject(viewer, personId, contact, Boolean(bien));

    let propertyId: string | null = null;
    if (bien && personId) {
      const created = await this.deps.biens.create(viewer, personId, {
        requestId: input.requestId,
        kind: bien.get('kind')!.value as PropertyKind,
        postalCode: bien.get('postalCode')!.value,
        city: bien.get('city')!.value,
        surfaceM2: bien.get('surfaceM2')!.value,
        rooms: bien.get('rooms')?.value ?? null,
        priceEur: bien.get('priceEur')?.value ?? null,
      });
      if (!created.ok) return created;
      propertyId = created.value.propertyId;
    }

    let booked: string | null = null;
    if (start && kind && personId) {
      const existing = await this.bookedFor(viewer, personId, kind, start, bien ? input.requestId : (counterVisit?.property_id ?? null), counterVisit?.project_id ?? null);
      if (existing) booked = existing;
      else {
        if (counterVisit && this.deps.visites) {
          // La contre-visite : même bien, même projet d'achat, avec son bon de visite ; aucune confirmation.
          let r: Awaited<ReturnType<Visites['schedule']>>;
          try {
            r = await this.deps.visites.schedule(viewer, { propertyId: counterVisit.property_id, projectId: counterVisit.project_id, start, channel: null });
          } catch (error) {
            if (!agendaDown(error)) throw error;
            return this.takenMeanwhile(viewer, input.requestId, { personId: null, contact: null, propertyId: null }, kind, start, AGENDA_DOWN_REFUSAL);
          }
          if (!r.ok) return this.takenMeanwhile(viewer, input.requestId, { personId: null, contact: null, propertyId: null }, kind, start, r);
          booked = r.visit.appointment.id;
        } else {
          // Aucune confirmation ne part : le contact n'a rien demandé par message.
          let r: Awaited<ReturnType<RendezVous['book']>>;
          try {
            r = await this.deps.rendezVous.book({ networkId: viewer.networkId, agentId: viewer.userId, personId, propertyId, kind, start, source: 'agent', channel: null });
          } catch (error) {
            // L'agenda tombé entre la vérification et la réservation : la fiche et le bien rangés sont nommés [R261, R702].
            if (!agendaDown(error)) throw error;
            return this.takenMeanwhile(viewer, input.requestId, { personId: contact ? personId : null, contact: contactState, propertyId }, kind, start, AGENDA_DOWN_REFUSAL);
          }
          if (!r.ok) return this.takenMeanwhile(viewer, input.requestId, { personId: contact ? personId : null, contact: contactState, propertyId }, kind, start, r);
          booked = r.appointment.id;
        }
      }
    }

    let delivery: DictationOutcome['report'] = null;
    if (report !== null && appointmentId !== null && this.deps.comptes) {
      const state = await this.db.first<{ status: string }>('SELECT status FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
      if (state?.status !== 'valide') {
        const d = await this.deps.comptes.dictate(viewer, appointmentId, this.forReport(input.dictation), { withoutWriter: true });
        if (!d.ok && d.code !== 'already_validated') return d;
      }
      const v = await this.deps.comptes.validate(viewer, appointmentId, report);
      if (!v.ok) return v;
      delivery = { delivery: v.delivery, rule: v.rule };
    }

    await appendEvent(
      this.journal,
      {
        type: 'dictee.validee',
        actor: this.actor(viewer),
        // Au journal de la personne dictée, sinon de la visite : son droit d'accès le retrouve [R96].
        subject: personId ? `person:${personId}` : `visit:${appointmentId}`,
        // Seulement des noms de champs et des identifiants : aucun texte dicté [R13].
        data: {
          rule: 'R261',
          request: input.requestId,
          contact: contactState ?? 'none',
          fields: [...kept.entries()].flatMap(([t, m]) => [...m.keys()].map((k) => `${t}.${k}`)).sort(),
          ...(personId ? { person: personId } : {}),
          ...(propertyId ? { property: propertyId } : {}),
          ...(booked ? { appointment: booked } : {}),
          report: delivery ? 'valide' : 'none',
        },
      },
      this.now,
    );
    return { ok: true, personId, contact: contactState, propertyId, appointmentId: booked, report: delivery };
  }

  /**
   * Le créneau pris entre la vérification et la réservation (RC22) : la fiche et le bien déjà rangés restent, jamais
   * effacés ; le refus les nomme et propose les créneaux libres les plus proches. Le compte rendu n'est pas validé : la
   * même demande rejouée sans le rendez-vous le validera, sans rien doubler [R261]. Au journal, des identifiants
   * seulement [R13].
   */
  private async takenMeanwhile(
    viewer: Viewer,
    requestId: string,
    kept: DictationKept,
    kind: AppointmentKind,
    start: Date,
    refusal: { rule: string | null; code: string },
  ): Promise<DictationRefusal> {
    const slotRefusal = refusal.rule === 'R32' || refusal.rule === 'R33';
    const stored = kept.personId !== null || kept.propertyId !== null;
    if (stored) {
      await appendEvent(
        this.journal,
        {
          type: 'dictee.creneau_pris',
          actor: this.actor(viewer),
          subject: kept.personId ? `person:${kept.personId}` : `property:${kept.propertyId}`,
          data: {
            rule: 'R261',
            request: requestId,
            refusal: refusal.code,
            contact: kept.contact ?? 'none',
            ...(kept.personId ? { person: kept.personId } : {}),
            ...(kept.propertyId ? { property: kept.propertyId } : {}),
          },
        },
        this.now,
      );
    }
    const out: DictationRefusal = { ok: false, rule: refusal.rule, code: slotRefusal ? 'slot_taken_meanwhile' : refusal.code };
    if (stored) out.kept = kept;
    if (slotRefusal) out.freeSlots = await this.nearestFree(viewer, kind, start);
    return out;
  }

  /** Les créneaux libres de la même sorte dans les 24 heures autour de celui dicté, les plus proches, jamais passés. */
  private async nearestFree(viewer: Viewer, kind: AppointmentKind, start: Date): Promise<string[]> {
    const now = this.now().getTime();
    const free = await this.deps.rendezVous.freeSlotsFor(viewer.userId, kind, new Date(start.getTime() - DAY_MS), new Date(start.getTime() + DAY_MS));
    return free
      .map((s) => s.start.getTime())
      .filter((t) => t > now && t !== start.getTime())
      .sort((a, b) => Math.abs(a - start.getTime()) - Math.abs(b - start.getTime()) || a - b)
      .slice(0, PROPOSED_SLOTS)
      .sort((a, b) => a - b)
      .map((t) => new Date(t).toISOString());
  }

  /**
   * Ce qu'une tentative d'avant de la même demande a rangé : la fiche créée sous son identifiant, le bien créé sous son
   * identifiant (avec la fiche à qui il est). Rien : `null`.
   */
  private async leftBy(viewer: Viewer, requestId: string, personId: string | null, contactState: DictationOutcome['contact']): Promise<DictationKept | null> {
    const person = contactState === 'created' && (await this.db.first('SELECT 1 AS ok FROM persons WHERE id = ? AND network_id = ? AND agent_id = ?', [requestId, viewer.networkId, viewer.userId]));
    const property = await this.db.first('SELECT 1 AS ok FROM properties WHERE id = ? AND network_id = ? AND agent_id = ?', [requestId, viewer.networkId, viewer.userId]);
    if (!person && !property) return null;
    return { personId, contact: contactState, propertyId: property ? requestId : null };
  }

  /**
   * Le rendez-vous de la même demande rejouée : même personne, heure, sorte et bien, et pour une contre-visite le même
   * projet d'achat. Un autre rendez-vous à cette heure n'est jamais pris pour celui-ci : le créneau sera refusé [R32].
   */
  private async bookedFor(viewer: Viewer, personId: string, kind: AppointmentKind, start: Date, propertyId: string | null, projectId: string | null): Promise<string | null> {
    const members = await this.deps.fiche.membersOf(personId);
    const row = await this.db.first<{ id: string }>(
      `SELECT a.id FROM appointments a
        WHERE a.agent_id = ? AND a.network_id = ? AND a.kind = ? AND a.start_at = ? AND a.status = 'booked' AND a.property_id IS ?
          AND a.person_id IN (${members.map(() => '?').join(', ')})
          AND (? IS NULL OR EXISTS (SELECT 1 FROM visits v WHERE v.appointment_id = a.id AND v.project_id = ?))
        ORDER BY a.created_at, a.id LIMIT 1`,
      [viewer.userId, viewer.networkId, kind, start.toISOString(), propertyId, ...members, projectId, projectId],
    );
    return row?.id ?? null;
  }

  /**
   * La fiche du contact dicté [R262] : celle qui porte déjà son téléphone ou son mail, si l'agent la suit ; celle déjà
   * créée par la même demande ; sinon une nouvelle, créée ensuite. Deux fiches distinctes : rien n'est fait.
   */
  private async contactOf(viewer: Viewer, requestId: string, contact: Map<DictatedKey, DictatedField>): Promise<{ ok: true; personId: string; state: 'created' | 'matched' } | DictationRefusal> {
    const mine = await this.db.first<{ id: string; network_id: string; agent_id: string | null }>('SELECT id, network_id, agent_id FROM persons WHERE id = ?', [requestId]);
    if (mine) {
      if (mine.network_id !== viewer.networkId || mine.agent_id !== viewer.userId) return { ok: false, rule: null, code: 'bad_request' };
      return { ok: true, personId: await this.deps.fiche.rootOf(mine.id), state: 'created' };
    }
    const roots = new Set<string>();
    for (const kind of ['phone', 'email'] as const) {
      const f = contact.get(kind);
      if (f) for (const p of await this.deps.fiche.findByIdentifier(viewer.networkId, kind, String(f.value))) roots.add(p.id);
    }
    if (roots.size > 1) return { ok: false, rule: 'R262', code: 'ambiguous_contact' };
    if (roots.size === 1) {
      const personId = [...roots][0]!;
      const read = await this.deps.acces.readFiche(viewer, personId);
      // La fiche d'un autre agent : rien n'en est dit, rien n'y est ajouté [R16].
      if (!read.ok || read.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
      return { ok: true, personId, state: 'matched' };
    }
    return { ok: true, personId: requestId, state: 'created' };
  }

  /** La fiche nouvelle, sous l'identifiant de la demande : rejouée, elle est retrouvée, jamais doublée. */
  private async createContact(viewer: Viewer, requestId: string, contact: Map<DictatedKey, DictatedField>): Promise<void> {
    if (!(await this.db.first('SELECT 1 AS ok FROM persons WHERE id = ?', [requestId]))) {
      const store = new FicheClient(this.db, { now: this.now, newId: () => requestId });
      try {
        await store.createPerson({
          networkId: viewer.networkId,
          agentId: viewer.userId,
          firstName: (contact.get('firstName')?.value as string | undefined) ?? null,
          lastName: (contact.get('lastName')?.value as string | undefined) ?? null,
        });
      } catch (error) {
        // Deux appuis en même temps : le second retrouve la fiche du premier.
        if (!/UNIQUE|PRIMARY/i.test(String(error))) throw error;
      }
    }
    await this.attachIdentifiers(viewer, requestId, contact);
  }

  private async attachIdentifiers(viewer: Viewer, personId: string, contact: Map<DictatedKey, DictatedField>): Promise<void> {
    for (const kind of ['phone', 'email'] as const satisfies readonly IdentifierKind[]) {
      const f = contact.get(kind);
      if (f) await this.deps.fiche.addIdentifier({ networkId: viewer.networkId, personId, kind, value: String(f.value) });
    }
  }

  /** Le projet dit (vendre ou acheter), ouvert s'il n'en a pas ; le bien ouvre lui-même son projet de vente. */
  private async openProject(viewer: Viewer, personId: string, contact: Map<DictatedKey, DictatedField>, withProperty: boolean): Promise<void> {
    const project = contact.get('project')?.value as 'sell' | 'buy' | undefined;
    if (!project || (project === 'sell' && withProperty)) return;
    const members = await this.deps.fiche.membersOf(personId);
    const open = await this.db.first('SELECT 1 AS ok FROM projects WHERE kind = ? AND person_id IN (' + members.map(() => '?').join(', ') + ') LIMIT 1', [project, ...members]);
    if (!open) await this.deps.store.createProject({ networkId: viewer.networkId, agentId: viewer.userId, personId, kind: project });
  }
}

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
import { checkReport, type ComptesRendus, type VisitReport } from '../visites/compte-rendu.ts';
import type { Visites } from '../visites/visites.ts';
import { DICTATION_KEYS, DICTATION_MAX_CHARS, fieldOf, readDictation, type DictatedField, type DictatedKey, type DictationDraft, type DictationTarget } from './lecture.ts';

export type DictationRefusal = { ok: false; rule: string | null; code: string; keys?: string[] };

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
      const preview = await this.deps.comptes.preview(viewer, input.appointmentId, input.dictation);
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
      const existing = await this.bookedFor(viewer, personId, kind, start);
      if (!existing) {
        const free = await this.deps.rendezVous.freeSlotsFor(viewer.userId, kind, new Date(start.getTime() - DAY_MS), new Date(start.getTime() + DAY_MS));
        if (!free.some((s) => s.start.getTime() === start.getTime())) return { ok: false, rule: 'R32', code: 'slot_not_free' };
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
      const existing = await this.bookedFor(viewer, personId, kind, start);
      if (existing) booked = existing;
      else {
        // Aucune confirmation ne part : le contact n'a rien demandé par message.
        const r = await this.deps.rendezVous.book({ networkId: viewer.networkId, agentId: viewer.userId, personId, propertyId, kind, start, source: 'agent', channel: null });
        if (!r.ok) return { ok: false, rule: r.rule, code: r.code };
        booked = r.appointment.id;
      }
    }

    let delivery: DictationOutcome['report'] = null;
    if (report !== null && appointmentId !== null && this.deps.comptes) {
      const state = await this.db.first<{ status: string }>('SELECT status FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
      if (state?.status !== 'valide') {
        const d = await this.deps.comptes.dictate(viewer, appointmentId, input.dictation, { withoutWriter: true });
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
        subject: `dictation:${input.requestId}`,
        // Seulement des noms de champs et des identifiants : aucun texte dicté [R13].
        data: {
          rule: 'R261',
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

  /** Un rendez-vous déjà pris pour cette personne, à cette heure et de cette sorte : la même demande rejouée. */
  private async bookedFor(viewer: Viewer, personId: string, kind: AppointmentKind, start: Date): Promise<string | null> {
    const members = await this.deps.fiche.membersOf(personId);
    const row = await this.db.first<{ id: string }>(
      `SELECT id FROM appointments WHERE agent_id = ? AND network_id = ? AND kind = ? AND start_at = ? AND status = 'booked' AND person_id IN (${members.map(() => '?').join(', ')}) ORDER BY created_at, id LIMIT 1`,
      [viewer.userId, viewer.networkId, kind, start.toISOString(), ...members],
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

/**
 * Bac à sable du premier parcours (M14, J07) — « Jamais vu ».
 *
 * Avant même son dossier complet, le nouvel agent reçoit une copie fidèle de son outil, à lui seul : les vrais
 * modules (captation, qualification, rappel, rendez-vous, avis de valeur) tournent sur une base à part, peuplée de
 * contacts, de biens et de ventes inventés. Il y fait son premier parcours complet, du contact reçu à l'avis de valeur
 * validé, sans aucun risque. Aucun réseau, logiciel ou outil d'IA grand public n'offre une copie fidèle et sans risque
 * de son propre outil pour apprendre le métier.
 *
 * Garanties :
 * - la base du bac à sable est une autre base (`SandboxStorage`), jamais celle du réseau : aucune donnée réelle n'y
 *   entre, aucun client réel n'y est lisible [R82] ;
 * - ses envois passent par le contrôle central, mais toujours vers la boîte d'essai de cette base : aucun vrai canal
 *   ne peut lui être donné, même quand le réseau est mis en service [R26, R01 à R04] ;
 * - les étapes sont cochées par le code, depuis les événements du journal du bac à sable, dans l'ordre, jamais
 *   saisies ; le journal du bac à sable est vérifié avant chaque lecture ;
 * - le parcours fini compte comme le module d'académie prévu pour lui.
 * Seul l'agent ouvre et fait son bac à sable ; la direction lit sa progression [R16].
 */
import type { Viewer } from '../acces/droits.ts';
import { createCaptation } from '../captation/chaine.ts';
import { trialChannels } from '../captation/essai.ts';
import { applyMigrations, type Migration } from '../db/migrations.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { AvisDeValeur } from '../estimation/avis.ts';
import { Fourchette, type Sale } from '../estimation/fourchette.ts';
import { appendEvent, verifyChain } from '../journal/journal.ts';
import { SqlJournalStore } from '../journal/sql-store.ts';
import type { JournalEntry, JournalStore } from '../journal/types.ts';
import { RendezVous } from '../rendezvous/reservation.ts';
import type { Academie } from './academie.ts';

/** Les étapes du premier parcours, dans l'ordre. */
export const SANDBOX_STEPS = ['contact_recu', 'qualification', 'rappel_fait', 'rendez_vous', 'avis_valide'] as const;
export type SandboxStep = (typeof SANDBOX_STEPS)[number];

export const SANDBOX_STEP_LABELS: Readonly<Record<SandboxStep, string>> = Object.freeze({
  contact_recu: 'Un vendeur vous écrit : votre assistant lui répond dans la minute.',
  qualification: 'Le contact est classé et vous est attribué, avec sa tâche « rappeler ».',
  rappel_fait: 'Vous le rappelez et marquez la tâche faite.',
  rendez_vous: "Vous fixez le rendez-vous d'estimation dans vos disponibilités.",
  avis_valide: "Vous relisez l'avis de valeur préparé par le code et le validez.",
});

/**
 * Les gestes que l'agent fait lui-même depuis son écran (AU025). La qualification n'en est pas un : elle se fait à
 * l'arrivée du contact, par la chaîne de captation.
 */
export const SANDBOX_GESTURES = ['contact_recu', 'rappel_fait', 'rendez_vous', 'avis_valide'] as const satisfies readonly SandboxStep[];
export type SandboxGesture = (typeof SANDBOX_GESTURES)[number];

/** La base à part du bac à sable d'un agent : toujours la même pour lui, jamais celle du réseau. */
export interface SandboxStorage {
  open(agentId: string): Promise<SqlDatabase>;
}

export interface BacASableOptions {
  migrations: readonly Migration[];
  storage: SandboxStorage;
  /** Le module d'académie que le parcours fini vaut. Absent : le parcours ne compte pas à l'académie. */
  academyModuleId?: string | null;
  now?: () => Date;
}

export type SandboxRefusal = { ok: false; rule: 'R16' | null; code: string };

export interface SandboxProgress {
  agentId: string;
  steps: { step: SandboxStep; label: string; done: boolean; at: string | null }[];
  /** La prochaine étape, en une phrase ; null quand tout est fait. */
  next: string | null;
  completed: boolean;
  /** Le parcours fini est compté au module d'académie prévu. */
  countedAtAcademy: boolean;
}

/**
 * Les contacts inventés qui écrivent à l'agent dans son bac à sable. Domaine réservé aux essais, aucune vraie personne.
 * Chacun est pressé : il reçoit sa tâche « rappeler », pour qu'un nouveau contact puisse toujours reprendre le parcours.
 */
export const SANDBOX_CONTACTS: readonly { email: string; message: string }[] = Object.freeze([
  { email: 'vendeur.un@essai.example', message: 'Bonjour, je souhaite vendre ma maison à Talant rapidement. Pouvez-vous l’estimer ?' },
  { email: 'vendeuse.deux@essai.example', message: 'Je voudrais vendre rapidement mon appartement à Talant, combien vaut-il ?' },
  { email: 'vendeur.trois@essai.example', message: 'Nous vendons rapidement la maison de famille à Talant, pouvez-vous passer ?' },
]);

/** Des ventes inventées autour d'un point fictif de Talant. */
export const SANDBOX_SALES: readonly Sale[] = Object.freeze(
  Array.from({ length: 14 }, (_, i) => ({
    id: `bac:${i}`,
    kind: 'house' as const,
    lat: 47.335 + i * 0.0002,
    lon: 4.99,
    surface: 90 + i * 3,
    pricePerM2: 2300 + i * 25,
    month: `2026-0${(i % 9) + 1}`,
  })),
);

/** Un identifiant stable, à la forme d'un UUID, tiré d'un texte. */
async function stableId(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bac-a-sable:${text}`)));
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Le monde du bac à sable : les vrais modules, sur la base à part. */
export interface SandboxWorld {
  /** La base à part, pour les routes et les tests : jamais montrée à l'agent. */
  db: SqlDatabase;
  networkId: string;
  agentId: string;
  /** L'agent tel que le voient les modules du bac à sable. */
  viewer: Viewer;
  propertyId: string;
  captation: ReturnType<typeof createCaptation>;
  rendezVous: RendezVous;
  avis: AvisDeValeur;
  fourchette: Fourchette;
  /** Un contact inventé écrit à l'agent ; la chaîne de captation fait le reste, en mode essai. */
  inventedContact(index?: number): Promise<{ personId: string | null; status: string }>;
}

export class BacASable {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly academie: Academie,
    private readonly options: BacASableOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, agentId: string, code: string): Promise<SandboxRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'sandbox', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(viewer: Viewer, agentId: string): Promise<boolean> {
    const row = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    return row?.status === 'active';
  }

  /** L'agent ouvre son bac à sable : créé et peuplé la première fois, retrouvé ensuite. Lui seul [R16]. */
  async open(viewer: Viewer): Promise<{ ok: true; world: SandboxWorld } | SandboxRefusal> {
    if (viewer.role !== 'agent') return this.refuse(viewer, viewer.userId, 'role');
    if (!(await this.activeAgent(viewer, viewer.userId))) return this.refuse(viewer, viewer.userId, 'agent_inactive');
    const agentId = viewer.userId;
    const world = await this.world(agentId);
    const at = this.now().toISOString();
    const { changes } = await this.db.run('INSERT INTO sandbox_runs (agent_id, network_id, opened_at, completed_at) VALUES (?, ?, ?, NULL) ON CONFLICT DO NOTHING', [agentId, viewer.networkId, at]);
    if (changes === 1) await appendEvent(this.journal, { type: 'bac_a_sable.ouvert', actor: this.actor(viewer), subject: `agent:${agentId}`, data: {} }, this.now);
    return { ok: true, world };
  }

  private async world(agentId: string): Promise<SandboxWorld> {
    const db = await this.options.storage.open(agentId);
    if (db === this.db) throw new Error('Bac à sable : la base doit être une autre base que celle du réseau.');
    await applyMigrations(db, this.options.migrations, this.now);
    const journal = new SqlJournalStore(db);
    const now = this.now;
    const networkId = await stableId(`reseau:${agentId}`);
    const propertyId = await stableId(`bien:${agentId}`);
    const stamp = now().toISOString();
    // Le réseau d'entraînement, l'agent (sous son propre identifiant, aucune autre donnée de lui), sa zone, un bien.
    const seeded = await db.first<{ id: string }>('SELECT id FROM networks WHERE id = ?', [networkId]);
    // Toujours et seulement la boîte d'essai de cette base : aucun vrai canal ne peut être passé ici [R26].
    const captation = createCaptation(db, journal, { now, channels: trialChannels(db, journal, now) });
    if (!seeded) {
      await db.run('INSERT INTO networks (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [networkId, "Bac à sable · réseau d'entraînement", stamp]);
      await db.run(
        "INSERT INTO agents (id, network_id, first_name, last_name, zone, status, sponsor_agent_id, created_at, updated_at) VALUES (?, ?, 'Vous', 'Bac à sable', 'Talant', 'active', NULL, ?, ?) ON CONFLICT DO NOTHING",
        [agentId, networkId, stamp, stamp],
      );
      await captation.attribution.addZone(networkId, agentId, 'Talant');
      await db.run(
        `INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, surface_m2, rooms, price_eur, status, created_at, updated_at)
         VALUES (?, ?, ?, 'BAC-1', 'home', '21240', 'Talant', 110, 5, NULL, 'draft', ?, ?) ON CONFLICT DO NOTHING`,
        [propertyId, networkId, agentId, stamp, stamp],
      );
    }
    const viewer: Viewer = { role: 'agent', userId: agentId, networkId };
    const fourchette = new Fourchette(
      {
        coverage: async () => ({ department: '21', lastSale: '2026-09-30', years: [2024, 2025, 2026], source: "Ventes inventées du bac à sable" }),
        within: async (kind) => SANDBOX_SALES.filter((s) => s.kind === kind),
      },
      undefined,
      now,
    );
    return {
      db,
      networkId,
      agentId,
      viewer,
      propertyId,
      captation,
      rendezVous: new RendezVous(db, journal, { now }),
      avis: new AvisDeValeur(db, journal, { now }),
      fourchette,
      inventedContact: async (index = 0) => {
        const contact = SANDBOX_CONTACTS[index % SANDBOX_CONTACTS.length]!;
        const [result] = await captation.chaine.receive(networkId, 'site_form', { submissionId: `bac-${index}`, email: contact.email, message: contact.message });
        const person = await db.first<{ person_id: string }>("SELECT person_id FROM person_identifiers WHERE network_id = ? AND kind = 'email' AND value = ?", [networkId, contact.email]);
        // Le message est arrivé et a reçu sa réponse d'essai : c'est ce qui ouvre le parcours.
        if (result?.status === 'replied' && person) {
          await appendEvent(journal, { type: 'bac_a_sable.contact_recu', actor: 'system:bac_a_sable', subject: `person:${person.person_id}`, data: { index } }, now);
        }
        return { personId: person?.person_id ?? null, status: result?.status ?? 'none' };
      },
    };
  }

  /**
   * Les étapes cochées depuis le journal du bac à sable, jamais saisies : chaque événement doit être suivi d'un geste
   * réellement rangé dans la base du bac à sable (contact inventé reçu, qualification, tâche faite par l'agent,
   * rendez-vous d'estimation réservé, avis validé par l'agent), pour la même personne, dans l'ordre du parcours.
   */
  private async stepsFrom(sandbox: SqlDatabase, entries: readonly JournalEntry[], agentId: string): Promise<Map<SandboxStep, string>> {
    return (await this.walk(sandbox, entries, agentId)).done;
  }

  /** Le parcours lu dans le journal du bac à sable : les étapes franchies, et la personne inventée qu'il suit. */
  private async walk(sandbox: SqlDatabase, entries: readonly JournalEntry[], agentId: string): Promise<{ done: Map<SandboxStep, string>; person: string | null }> {
    const done = new Map<SandboxStep, string>();
    const store = new FicheClient(sandbox);
    const fiche = new FicheUnique(sandbox, store);
    const id = (subject: string | null, prefix: string): string | null => (subject !== null && subject.startsWith(`${prefix}:`) ? subject.slice(prefix.length + 1) : null);
    const rootOf = async (personId: string | null): Promise<string | null> => (personId === null || !(await store.getPerson(personId)) ? null : fiche.rootOf(personId));
    const byAgent = (e: JournalEntry): boolean => e.actor === `agent:${agentId}`;

    // Les contacts inventés arrivés, dans l'ordre. Le parcours suit le premier qui a été qualifié ; sans aucun qualifié
    // (une qualification tombée en panne), le premier arrivé, et un nouveau contact peut alors être reçu (AU025).
    const arrivals: { root: string | null; seq: number; at: string }[] = [];
    for (const e of entries) {
      if (e.type !== 'bac_a_sable.contact_recu' || e.actor !== 'system:bac_a_sable') continue;
      const p = id(e.subject, 'person');
      const invented = p === null ? null : await sandbox.first("SELECT 1 AS ok FROM person_identifiers WHERE person_id = ? AND kind = 'email' AND value LIKE '%@essai.example'", [p]);
      const inbound = p === null ? null : await sandbox.first("SELECT 1 AS ok FROM messages WHERE person_id = ? AND direction = 'in'", [p]);
      if (invented && inbound) arrivals.push({ root: await rootOf(p), seq: e.seq, at: e.at });
    }
    if (arrivals.length === 0) return { done, person: null };

    // La qualification se fait pendant la réception : elle peut précéder l'arrivée rangée, pour la même personne.
    const qualifiedAt = async (root: string | null): Promise<string | null> => {
      for (const e of entries) {
        if (e.type !== 'qualification.rangee' || (await rootOf(id(e.subject, 'person'))) !== root) continue;
        const row = await sandbox.first<{ person_id: string }>('SELECT person_id FROM qualifications WHERE person_id = ?', [id(e.subject, 'person')]);
        if (row) return e.at;
      }
      return null;
    };
    let chosen = arrivals[0]!;
    let qualification: string | null = null;
    for (const a of arrivals) {
      qualification = await qualifiedAt(a.root);
      if (qualification !== null) {
        chosen = a;
        break;
      }
    }
    const person = chosen.root;
    let seq = chosen.seq;
    done.set('contact_recu', chosen.at);
    if (person === null) return { done, person };
    if (qualification !== null) done.set('qualification', qualification);
    const sameRoot = async (p: string | null): Promise<boolean> => (await rootOf(p)) === person;
    if (!done.has('qualification')) return { done, person };

    const next = async (step: SandboxStep, check: (e: JournalEntry) => Promise<boolean>): Promise<boolean> => {
      for (const e of entries) {
        if (e.seq <= seq || !(await check(e))) continue;
        seq = e.seq;
        done.set(step, e.at);
        return true;
      }
      return false;
    };
    const rappel = await next('rappel_fait', async (e) => {
      if (e.type !== 'rappel.fait' || !byAgent(e) || typeof e.data.task !== 'string') return false;
      const task = await sandbox.first<{ person_id: string }>('SELECT person_id FROM callback_tasks WHERE id = ? AND done_at IS NOT NULL', [e.data.task]);
      return task !== null && (await sameRoot(task.person_id));
    });
    if (!rappel) return { done, person };
    const rdv = await next('rendez_vous', async (e) => {
      if (e.type !== 'rdv.reserve') return false;
      const a = await sandbox.first<{ person_id: string }>("SELECT person_id FROM appointments WHERE id = ? AND agent_id = ? AND kind = 'estimation'", [id(e.subject, 'appointment'), agentId]);
      return a !== null && (await sameRoot(a.person_id));
    });
    if (!rdv) return { done, person };
    await next('avis_valide', async (e) => {
      if (e.type !== 'avis.valide' || !byAgent(e) || typeof e.data.report !== 'string') return false;
      const r = await sandbox.first("SELECT 1 AS ok FROM valuation_reports WHERE id = ? AND status = 'validated' AND validated_by = ?", [e.data.report, agentId]);
      return r !== null;
    });
    return { done, person };
  }

  /**
   * La progression du parcours : lue par l'agent lui-même et par la direction [R16]. Chaque étape franchie est rangée
   * une fois ; le parcours fini compte au module d'académie prévu, une seule fois.
   */
  async progress(viewer: Viewer, agentId: string): Promise<{ ok: true; value: SandboxProgress } | SandboxRefusal> {
    const allowed = viewer.role === 'direction' || (viewer.role === 'agent' && viewer.userId === agentId);
    if (!allowed) return this.refuse(viewer, agentId, viewer.role === 'agent' ? 'not_assigned' : 'role');
    const run = await this.db.first<{ completed_at: string | null }>('SELECT completed_at FROM sandbox_runs WHERE agent_id = ? AND network_id = ?', [agentId, viewer.networkId]);
    if (!run) return { ok: false, rule: null, code: 'not_opened' };
    const sandbox = await this.options.storage.open(agentId);
    const entries = await new SqlJournalStore(sandbox).all();
    const chain = await verifyChain(entries);
    if (!chain.ok) {
      await appendEvent(this.journal, { type: 'bac_a_sable.journal_casse', actor: 'system:bac_a_sable', subject: `agent:${agentId}`, data: {} }, this.now);
      return { ok: false, rule: null, code: 'broken_journal' };
    }
    const done = await this.stepsFrom(sandbox, entries, agentId);
    const at = this.now().toISOString();
    for (const [step, stepAt] of done) {
      const { changes } = await this.db.run('INSERT INTO sandbox_steps (agent_id, network_id, step, done_at, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [agentId, viewer.networkId, step, stepAt, at]);
      if (changes === 1) await appendEvent(this.journal, { type: 'bac_a_sable.etape', actor: 'system:bac_a_sable', subject: `agent:${agentId}`, data: { step } }, this.now);
    }
    const completed = done.size === SANDBOX_STEPS.length;
    if (completed && run.completed_at === null) {
      const { changes } = await this.db.run('UPDATE sandbox_runs SET completed_at = ? WHERE agent_id = ? AND completed_at IS NULL', [at, agentId]);
      if (changes === 1) await appendEvent(this.journal, { type: 'bac_a_sable.fini', actor: 'system:bac_a_sable', subject: `agent:${agentId}`, data: {} }, this.now);
    }
    // Le parcours fini compte au module prévu ; tant qu'il n'y est pas, chaque lecture le retente et le refus va au journal.
    let counted = false;
    if (completed && this.options.academyModuleId) {
      const moduleId = this.options.academyModuleId;
      const known = await this.db.first('SELECT 1 AS ok FROM academy_completions WHERE agent_id = ? AND module_id = ?', [agentId, moduleId]);
      if (known) counted = true;
      else {
        const r = await this.academie.complete({ role: 'agent', userId: agentId, networkId: viewer.networkId }, moduleId);
        counted = r.ok;
        if (!r.ok) await appendEvent(this.journal, { type: 'bac_a_sable.academie_refusee', actor: 'system:bac_a_sable', subject: `agent:${agentId}`, data: { code: r.code } }, this.now);
      }
    }
    const steps = SANDBOX_STEPS.map((step) => ({ step, label: SANDBOX_STEP_LABELS[step], done: done.has(step), at: done.get(step) ?? null }));
    const next = steps.find((s) => !s.done);
    return { ok: true, value: { agentId, steps, next: next ? next.label : null, completed, countedAtAcademy: counted } };
  }

  /**
   * AU025 · L'agent fait, depuis son écran, la prochaine étape de son parcours : un geste réel des vrais modules, joué
   * dans sa base à part, jamais une case cochée. Seule la prochaine étape s'ouvre ; l'étape est ensuite reconnue par le
   * journal du bac à sable, comme toujours. Lui seul [R16] ; rien ne sort du bac à sable [R26].
   */
  async act(viewer: Viewer, gesture: string): Promise<{ ok: true; value: SandboxProgress } | SandboxRefusal> {
    if (viewer.role !== 'agent') return this.refuse(viewer, viewer.userId, 'role');
    const agentId = viewer.userId;
    if (!(SANDBOX_GESTURES as readonly string[]).includes(gesture)) return { ok: false, rule: null, code: 'invalid_step' };
    const before = await this.progress(viewer, agentId);
    if (!before.ok) return before;
    const next = before.value.steps.find((s) => !s.done);
    if (!next) return { ok: false, rule: null, code: 'completed' };
    // Une qualification tombée en panne : un nouveau contact inventé reprend le parcours.
    const expected = next.step === 'qualification' ? 'contact_recu' : next.step;
    if (expected !== gesture) return { ok: false, rule: null, code: 'not_next_step' };
    if (!(await this.activeAgent(viewer, agentId))) return this.refuse(viewer, agentId, 'agent_inactive');
    const world = await this.world(agentId);
    const done = await this.gesture(world, gesture as SandboxGesture);
    if (!done) return { ok: false, rule: null, code: 'step_failed' };
    return this.progress(viewer, agentId);
  }

  private async gesture(world: SandboxWorld, gesture: SandboxGesture): Promise<boolean> {
    if (gesture === 'contact_recu') {
      // Un nouveau contact inventé à chaque essai : un essai interrompu ne bloque jamais le suivant.
      const n = Number((await world.db.first<{ n: number }>('SELECT count(*) AS n FROM persons'))?.n ?? 0);
      return (await world.inventedContact(n)).status === 'replied';
    }
    const { person } = await this.walk(world.db, await new SqlJournalStore(world.db).all(), world.agentId);
    if (person === null) return false;
    const fiche = new FicheUnique(world.db, new FicheClient(world.db));
    const same = async (p: string | null): Promise<boolean> => p !== null && (await fiche.rootOf(p)) === person;
    if (gesture === 'rappel_fait') {
      const hot = await world.captation.rappels.hotList(world.captation.acces, world.viewer);
      if (!hot.ok) return false;
      for (const c of hot.value.contacts) {
        if (await same(c.personId)) return world.captation.rappels.done(world.captation.acces, world.viewer, c.taskId);
      }
      return false;
    }
    if (gesture === 'rendez_vous') {
      if (!(await world.rendezVous.availabilityOf(world.agentId))) {
        const set = await world.rendezVous.setAvailability(world.viewer, { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '18:00' })) });
        if (!set.ok) return false;
      }
      // Le premier jour ouvré libre à partir de demain, en fin de matinée (heure de Paris, hiver comme été).
      const today = this.now();
      for (let d = 1; d <= 14; d += 1) {
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d, 9, 0));
        if (start.getUTCDay() === 0 || start.getUTCDay() === 6) continue;
        const booked = await world.rendezVous.book({ networkId: world.networkId, agentId: world.agentId, personId: person, propertyId: world.propertyId, kind: 'estimation', start, source: 'agent', channel: 'email' });
        if (booked.ok) return true;
      }
      return false;
    }
    const range = await world.fourchette.estimate({ kind: 'house', surface: 110, lat: 47.335, lon: 4.99, postalCode: '21240' });
    if (!range.ok) return false;
    const report = await world.avis.draft({ networkId: world.networkId, propertyId: world.propertyId, kind: 'house', surface: 110, range });
    return (await world.avis.validate(world.viewer, report.id)).ok;
  }
}

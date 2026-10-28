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
}

/** Les contacts inventés qui écrivent à l'agent dans son bac à sable. Domaine réservé aux essais, aucune vraie personne. */
export const SANDBOX_CONTACTS: readonly { email: string; message: string }[] = Object.freeze([
  { email: 'vendeur.un@essai.example', message: 'Bonjour, je souhaite vendre ma maison à Talant rapidement. Pouvez-vous l’estimer ?' },
  { email: 'vendeuse.deux@essai.example', message: 'Je voudrais vendre mon appartement à Talant, combien vaut-il ?' },
  { email: 'vendeur.trois@essai.example', message: 'Nous vendons la maison de famille à Talant, pouvez-vous passer ?' },
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
  db: SqlDatabase;
  journal: JournalStore;
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
      journal,
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
        // L'arrivée du message, rangée avant que la chaîne ne le traite : c'est elle qui ouvre le parcours.
        await appendEvent(journal, { type: 'bac_a_sable.contact_recu', actor: 'system:bac_a_sable', subject: null, data: { index } }, now);
        const [result] = await captation.chaine.receive(networkId, 'site_form', { submissionId: `bac-${index}`, email: contact.email, message: contact.message });
        const person = await db.first<{ person_id: string }>("SELECT person_id FROM person_identifiers WHERE network_id = ? AND kind = 'email' AND value = ?", [networkId, contact.email]);
        return { personId: person?.person_id ?? null, status: result?.status ?? 'none' };
      },
    };
  }

  /** Les étapes cochées dans l'ordre depuis le journal du bac à sable, jamais saisies. */
  private stepsFrom(entries: readonly JournalEntry[], agentId: string): Map<SandboxStep, string> {
    const done = new Map<SandboxStep, string>();
    const actorIsAgent = (e: JournalEntry): boolean => e.actor === `agent:${agentId}`;
    const matches: Record<SandboxStep, (e: JournalEntry) => boolean> = {
      contact_recu: (e) => e.type === 'bac_a_sable.contact_recu' && e.actor === 'system:bac_a_sable',
      qualification: (e) => e.type === 'qualification.rangee',
      rappel_fait: (e) => e.type === 'rappel.fait' && actorIsAgent(e),
      rendez_vous: (e) => e.type === 'rdv.reserve' && e.data.kind === 'estimation' && e.data.agent === agentId,
      avis_valide: (e) => e.type === 'avis.valide' && actorIsAgent(e),
    };
    let index = 0;
    for (const entry of entries) {
      const step = SANDBOX_STEPS[index];
      if (step === undefined) break;
      if (matches[step](entry)) {
        done.set(step, entry.at);
        index += 1;
      }
    }
    return done;
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
    const done = this.stepsFrom(entries, agentId);
    const at = this.now().toISOString();
    for (const [step, stepAt] of done) {
      const { changes } = await this.db.run('INSERT INTO sandbox_steps (agent_id, network_id, step, done_at, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [agentId, viewer.networkId, step, stepAt, at]);
      if (changes === 1) await appendEvent(this.journal, { type: 'bac_a_sable.etape', actor: 'system:bac_a_sable', subject: `agent:${agentId}`, data: { step } }, this.now);
    }
    const completed = done.size === SANDBOX_STEPS.length;
    if (completed && run.completed_at === null) {
      const { changes } = await this.db.run('UPDATE sandbox_runs SET completed_at = ? WHERE agent_id = ? AND completed_at IS NULL', [at, agentId]);
      if (changes === 1) {
        await appendEvent(this.journal, { type: 'bac_a_sable.fini', actor: 'system:bac_a_sable', subject: `agent:${agentId}`, data: {} }, this.now);
        if (this.options.academyModuleId) await this.academie.complete({ role: 'agent', userId: agentId, networkId: viewer.networkId }, this.options.academyModuleId);
      }
    }
    const steps = SANDBOX_STEPS.map((step) => ({ step, label: SANDBOX_STEP_LABELS[step], done: done.has(step), at: done.get(step) ?? null }));
    const next = steps.find((s) => !s.done);
    return { ok: true, value: { agentId, steps, next: next ? next.label : null, completed } };
  }
}

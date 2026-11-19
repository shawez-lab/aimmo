/**
 * L'alerte WhatsApp en un geste, par le téléphone de l'agent (M08, T09). L'agent demande, pour un acquéreur que le bien
 * remplit, un lien WhatsApp pré-rempli. Le contrôle central décide d'abord : arrêt, exclusions, horaires, accord des
 * alertes sur WhatsApp, jamais deux fois le même bien [R01 à R05, R49], sans la fenêtre de Meta ni le silence de
 * l'assistant, qui ne valent que pour les envois automatiques. Le lien est rendu à l'agent, jamais ouvert ni envoyé par
 * le serveur ; il porte le lien de désinscription. L'agent confirme ensuite l'envoi, une seule fois [R18].
 *
 * Décidé, lecture prudente : le message est rangé, écrit par l'agent, dès que le lien est préparé, pour que le bien ne
 * soit jamais proposé deux fois même si l'agent oublie de confirmer [R05] ; la confirmation dit qu'il est parti. Le
 * texte est celui du code, sans IA. Ni le lien, ni le numéro, ni le texte ne vont au journal [R13].
 */
import { areaOfProject } from './secteurs.ts';
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Project } from '../db/types.ts';
import { Diffusion } from '../documents/retractation.ts';
import { AgentWhatsAppLink } from '../envoi/canaux.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ALERT_PURPOSE, alertFallbackText, checkUnsubscribeBase, newUnsubscribeLine } from './alertes.ts';
import { EMPTY_SEARCH, FicheAcquereur } from './fiche-acquereur.ts';
import { CLOSED_STAGES, DEFAULT_ACTIVE_DAYS, Rapprochement, matchBuyer, type DiffusionGate } from './rapprochement.ts';

export type WhatsAppRefusal = { ok: false; rule: string | null; code: string; reason?: string };

export interface WhatsAppAgentOptions {
  diffusion?: DiffusionGate;
  /** Le début du lien de désinscription ; absent, aucun lien n'est préparé [R49]. */
  unsubscribeBase?: string | null;
  now?: () => Date;
}

export class AlerteWhatsApp {
  private readonly now: () => Date;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly gate: DiffusionGate;
  private readonly acquereurs: FicheAcquereur;
  private readonly rapprochement: Rapprochement;
  private readonly unsubscribeBase: string | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly acces: Acces,
    options: WhatsAppAgentOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.controle = new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, this.store, this.fiche, { now: this.now }), {
      // Les canaux du réseau ne servent pas ici : le message de l'agent va au port de l'agent seulement.
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.gate = options.diffusion ?? new Diffusion(db, acces, journal, { now: this.now });
    this.acquereurs = new FicheAcquereur(db, journal, { now: this.now });
    this.rapprochement = new Rapprochement(db, this.fiche, this.gate, journal, { now: this.now });
    this.unsubscribeBase = checkUnsubscribeBase(options.unsubscribeBase ?? null);
  }

  /** Le lien pré-rempli pour un acquéreur et un bien, après le contrôle central ; rendu à l'agent seulement. */
  async prepare(viewer: Viewer, propertyId: string, projectId: string): Promise<{ ok: true; link: string; messageId: string } | WhatsAppRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `project:${projectId}`, 'role');
    const project = await this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'buy'", [projectId, viewer.networkId]);
    if (!project) return this.refused(viewer, `project:${projectId}`, 'unknown');
    const fiche = await this.acces.readFiche(viewer, project.person_id);
    if (!fiche.ok) return { ok: false, rule: 'R16', code: fiche.code };
    if (fiche.view !== 'full') return this.refused(viewer, `project:${projectId}`, 'not_assigned');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    // L'agent qui envoie : celui qui demande, ou, pour la direction, l'agent qui suit la personne.
    const root = fiche.value.person;
    const agentId = viewer.role === 'agent' ? viewer.userId : (fiche.value.members.map((m) => m.agent_id).find((a) => a !== null) ?? null);
    // Chaque refus avant le contrôle central va au journal, avec sa règle, sans donnée [R13].
    const stop = async (rule: string | null, code: string): Promise<WhatsAppRefusal> => {
      await appendEvent(
        this.journal,
        { type: 'alerte.whatsapp.refusee', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${root.id}`, data: { rule, code, property: propertyId } },
        this.now,
      );
      return { ok: false, rule, code };
    };
    if (!agentId) return stop(null, 'no_agent');
    if (this.unsubscribeBase === null) return stop('R49', 'no_unsubscribe_link');
    const gate = await this.gate.canDiffuse(viewer.networkId, propertyId, this.now());
    if (!gate.allowed) return stop('R42', gate.reason);
    // Comme le rapprochement : un projet clos, ou une recherche sans nouvelle depuis trop longtemps, ne compte plus.
    const saved = await this.acquereurs.current(projectId);
    // Le secteur privé de la recherche compte aussi pour l'alerte de l'agent ; un projet au seul secteur a une recherche vide (AU073).
    const area = await areaOfProject(this.db, projectId);
    const areaSet = await this.db.first<{ at: string | null }>('SELECT max(set_at) AS at FROM buyer_search_areas WHERE project_id = ?', [projectId]);
    const search = saved ? saved.search : area ? { ...EMPTY_SEARCH, propertyKinds: [], communes: [], features: [], requiredFeatures: [] } : null;
    // AU074 · une recherche dite toujours d'actualité compte depuis sa dernière confirmation ; un secteur rangé la rafraîchit aussi.
    const confirmed = await this.db.first<{ at: string | null }>('SELECT max(confirmed_at) AS at FROM buyer_search_confirmations WHERE project_id = ?', [projectId]);
    const movedAt = [saved?.createdAt, confirmed?.at, areaSet?.at].filter((d): d is string => typeof d === 'string').sort().at(-1);
    const stale = movedAt !== undefined && Date.parse(movedAt) < this.now().getTime() - DEFAULT_ACTIVE_DAYS * 86_400_000;
    if (!search || CLOSED_STAGES.includes(project.stage) || stale) return stop('R51', 'inactive');
    const property = await this.rapprochement.propertyForMatch(read.value);
    if (matchBuyer(property, area ? { ...search, area } : search).status === 'miss') return stop('R51', 'not_matching');

    const at = this.now();
    const line = await newUnsubscribeLine(this.db, viewer.networkId, root.id, this.unsubscribeBase, at);
    const firstName = fiche.value.members.map((m) => m.first_name).find((n) => n) ?? null;
    const port = new AgentWhatsAppLink();
    const result = await this.controle.send({
      networkId: viewer.networkId,
      agentId,
      personId: root.id,
      projectId,
      channel: 'whatsapp',
      kind: 'alert',
      purpose: ALERT_PURPOSE,
      consentOnEveryChannel: true,
      stillAllowed: async () => {
        const d = await this.gate.canDiffuse(viewer.networkId, propertyId, this.now());
        return { allowed: d.allowed, rule: 'R42', reason: d.allowed ? 'Bien diffusable.' : 'Le bien ne peut plus être diffusé.' };
      },
      propertyIds: [propertyId],
      byAgent: { port },
      fallbackTexts: [`${alertFallbackText(firstName, property, 'whatsapp', true)}\n\n${line}`],
      figures: [property.priceEur, property.surfaceM2, property.rooms, property.bedrooms].filter((n): n is number => n !== null),
    });
    if (result.status !== 'sent' || !result.messageId || !port.link) {
      // Le refus du contrôle central est déjà dans le journal des envois [R13].
      return { ok: false, rule: result.rule, code: result.status, reason: result.reason };
    }
    await this.db.run(
      'INSERT INTO agent_whatsapp_alerts (message_id, network_id, property_id, person_id, agent_id, prepared_at, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
      [result.messageId, viewer.networkId, propertyId, root.id, agentId, at.toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'alerte.whatsapp.preparee', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${root.id}`, data: { property: propertyId, message: result.messageId } },
      this.now,
    );
    return { ok: true, link: port.link, messageId: result.messageId };
  }

  /** L'agent confirme que le message est parti : une seule fois, par l'agent qui l'a préparé ou la direction [R16, R18]. */
  async confirm(viewer: Viewer, messageId: string): Promise<{ ok: true; confirmedAt: string } | WhatsAppRefusal> {
    const row = await this.db.first<{ network_id: string; person_id: string; agent_id: string; confirmed_at: string | null }>(
      'SELECT network_id, person_id, agent_id, confirmed_at FROM agent_whatsapp_alerts WHERE message_id = ?',
      [messageId],
    );
    if (!row || row.network_id !== viewer.networkId) return this.refused(viewer, `message:${messageId}`, 'unknown');
    const allowed = (viewer.role === 'agent' && viewer.userId === row.agent_id) || viewer.role === 'direction';
    if (!allowed) return this.refused(viewer, `message:${messageId}`, viewer.role === 'agent' ? 'not_assigned' : 'role');
    if (viewer.role === 'agent') {
      const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
      if (agent?.status !== 'active') return this.refused(viewer, `message:${messageId}`, 'agent_inactive');
    }
    const at = this.now().toISOString();
    const { changes } = await this.db.run('UPDATE agent_whatsapp_alerts SET confirmed_at = ?, confirmed_by = ? WHERE message_id = ? AND confirmed_at IS NULL', [
      at,
      `${viewer.role}:${viewer.userId}`,
      messageId,
    ]);
    if (changes === 1) {
      await appendEvent(
        this.journal,
        { type: 'alerte.whatsapp.confirmee', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${row.person_id}`, data: { message: messageId } },
        this.now,
      );
      return { ok: true, confirmedAt: at };
    }
    return { ok: true, confirmedAt: row.confirmed_at ?? at };
  }

  private async refused(viewer: Viewer, subject: string, code: string): Promise<WhatsAppRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'whatsapp_agent', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}

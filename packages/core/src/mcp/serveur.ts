/**
 * Serveur MCP d'AIMMO et lecture publique des biens (Intégrations, HX55) [R590, R591, R592, R16, R13, R42, R46].
 *
 * L'agent pilote AIMMO depuis son assistant (ChatGPT, Claude) par le protocole MCP (JSON-RPC 2.0, outils). **Jamais
 * vu** : chaque outil agit sous les droits de l'agent de S08, revérifiés à chaque appel ; il n'écrit que des
 * brouillons que l'agent valide lui-même dans l'application ; chaque appel, et chaque refus, passe au journal avant
 * que la moindre donnée ne soit rendue. Le serveur ne rend aucune donnée de client : ni nom, ni téléphone, ni mail, ni
 * adresse ne sortent vers un assistant d'IA ; une fiche ne s'y désigne que par son identifiant [R590].
 *
 * Sans agent, le même serveur répond aux assistants d'achat (comme AQQI) et aux partenaires par un seul outil : les
 * biens que la diffusion autorise à l'instant même, et seulement ce que leur annonce publiée dit, sans adresse ni
 * donnée personnelle, ni agent [R592].
 *
 * Le catalogue d'outils est fermé : un outil inconnu est refusé, aucun outil ne valide un brouillon.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { LISTABLE_STATUSES, type ListingGate } from '../attirer/liste-biens.ts';
import type { PublishedListing } from '../attirer/referencement.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Property } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Brouillons, Draft } from './brouillons.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const PUBLIC_LISTINGS_MAX = 50;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Json>; required: string[]; additionalProperties: false };
  /** `public` : sans agent ; `lecture` : sous les droits de l'agent ; `brouillon` : écrit seulement un brouillon. */
  access: 'public' | 'lecture' | 'brouillon';
}

const ID_SCHEMA: Json = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };

/** Le catalogue fermé des outils. Aucun outil ne valide, n'envoie ni n'efface quoi que ce soit [R591]. */
export const MCP_TOOLS: readonly ToolDef[] = [
  {
    name: 'biens_diffusables',
    description: 'Les biens en vente que la diffusion autorise à cet instant, avec ce que dit leur annonce publiée : titre, prix, commune, mentions. Jamais d’adresse.',
    inputSchema: { type: 'object', properties: { commune: { type: 'string', maxLength: 80 } }, required: [], additionalProperties: false },
    access: 'public',
  },
  {
    name: 'mes_biens',
    description: 'Les biens que vous tenez vous-même, sans aucune donnée de client.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    access: 'lecture',
  },
  {
    name: 'lire_bien',
    description: 'Un bien que vous tenez, ou un bien en vente du fichier commun du réseau, sans aucune donnée de client.',
    inputSchema: { type: 'object', properties: { bien: ID_SCHEMA }, required: ['bien'], additionalProperties: false },
    access: 'lecture',
  },
  {
    name: 'mes_brouillons',
    description: 'Vos brouillons et leur état : à valider, validé ou refusé dans l’application.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    access: 'lecture',
  },
  {
    name: 'brouillon_note',
    description: 'Prépare une note pour une fiche que vous suivez. Rien n’est rangé dans la fiche : vous la validez dans l’application.',
    inputSchema: { type: 'object', properties: { fiche: ID_SCHEMA, texte: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['fiche', 'texte'], additionalProperties: false },
    access: 'brouillon',
  },
  {
    name: 'brouillon_prix',
    description: 'Prépare un nouveau prix pour un bien que vous tenez. Rien ne change : vous le validez dans l’application, et le prix suit ensuite le mandat.',
    inputSchema: { type: 'object', properties: { bien: ID_SCHEMA, prix_eur: { type: 'integer', minimum: 1, maximum: 100000000 } }, required: ['bien', 'prix_eur'], additionalProperties: false },
    access: 'brouillon',
  },
];

/** Qui parle au serveur : un agent authentifié par sa clé (S09), ou personne (lecture publique) pour un réseau. */
export type McpCaller = { kind: 'agent'; viewer: Viewer } | { kind: 'public'; networkId: string };

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Json;
  error?: { code: number; message: string };
}

/** Un bien de la lecture publique : ce que dit l'annonce publiée, rien d'autre [R592]. */
export interface PublicListing {
  bien: string;
  titre: string;
  prix_eur: number;
  etat: 'en_vente' | 'sous_offre';
  commune: string | null;
  mentions: string;
}

/** Les champs d'un bien rendus à l'assistant : aucun ne porte de donnée de client [R590]. */
export interface ToolProperty {
  bien: string;
  reference: string;
  type: string;
  commune: string | null;
  code_postal: string | null;
  surface_m2: number | null;
  pieces: number | null;
  prix_fiche_eur: number | null;
  statut: string;
  vue: 'complete' | 'fichier_commun';
}

export interface ServeurMcpDeps {
  db: SqlDatabase;
  acces: Acces;
  brouillons: Brouillons;
  journal: JournalStore;
  /** Les annonces publiées du réseau (`Referencement.published`). */
  published: { published(networkId: string): Promise<PublishedListing[]> };
  /** La porte de diffusion, demandée à l'instant même pour chaque bien [R42]. */
  gate: ListingGate;
  now?: () => Date;
}

type ToolOutcome = { ok: true; value: Json } | { ok: false; rule: string; code: string };

const ARG_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ServeurMcp {
  private readonly now: () => Date;

  constructor(private readonly deps: ServeurMcpDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Les outils que ce correspondant peut appeler. */
  toolsFor(caller: McpCaller): readonly ToolDef[] {
    return MCP_TOOLS.filter((t) => (caller.kind === 'public' ? t.access === 'public' : true));
  }

  /**
   * Une requête JSON-RPC 2.0. Rend `null` pour une notification (sans identifiant), qui n'attend pas de réponse. Une
   * panne du journal n'est pas avalée : elle remonte, et rien n'est rendu [R13].
   */
  async handle(caller: McpCaller, request: unknown): Promise<JsonRpcResponse | null> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return rpcError(null, -32600, 'Requête invalide.');
    const r = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = typeof r.id === 'string' || (typeof r.id === 'number' && Number.isInteger(r.id)) ? r.id : null;
    if (r.jsonrpc !== '2.0' || typeof r.method !== 'string') return rpcError(id, -32600, 'Requête invalide.');
    if (r.id === undefined) return null;
    if (id === null) return rpcError(null, -32600, 'Requête invalide.');
    switch (r.method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aimmo', version: '1' },
          instructions:
            caller.kind === 'public'
              ? 'Biens en vente d’un réseau AIMMO, tels que leur annonce publiée les décrit.'
              : 'AIMMO sous vos droits d’agent. Les outils lisent et préparent des brouillons ; vous les validez dans l’application.',
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: this.toolsFor(caller).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as unknown as Json })),
        });
      case 'tools/call':
        return this.call(caller, id, r.params);
      default:
        return rpcError(id, -32601, 'Méthode inconnue.');
    }
  }

  private async call(caller: McpCaller, id: string | number, params: unknown): Promise<JsonRpcResponse> {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return rpcError(id, -32602, 'Paramètres invalides.');
    const p = params as { name?: unknown; arguments?: unknown };
    const args = p.arguments === undefined ? {} : p.arguments;
    const tool = this.toolsFor(caller).find((t) => t.name === p.name);
    if (!tool) {
      await this.log(caller, 'mcp.refus', { rule: 'R590', code: 'unknown_tool' });
      return rpcError(id, -32602, 'Outil inconnu.');
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args) || !argsMatch(tool, args as Record<string, unknown>)) {
      await this.log(caller, 'mcp.refus', { rule: 'R590', code: 'bad_input', tool: tool.name });
      return toolResult(id, { ok: false, rule: 'R590', code: 'bad_input' });
    }
    const a = args as Record<string, unknown>;
    // Le journal d'abord : chaque appel y est écrit avant que la moindre donnée ne soit rendue [R13, R590].
    await this.log(caller, 'mcp.appel', { rule: 'R590', tool: tool.name });
    let outcome: ToolOutcome;
    if (caller.kind === 'public') outcome = await this.publicListings(caller.networkId, a.commune);
    else if (!(await this.activeAgent(caller.viewer))) outcome = { ok: false, rule: 'R16', code: caller.viewer.role === 'agent' ? 'agent_inactive' : 'role' };
    else if (tool.access === 'public') outcome = await this.publicListings(caller.viewer.networkId, a.commune);
    else outcome = await this.agentTool(caller.viewer, tool.name, a);
    if (!outcome.ok) await this.log(caller, 'mcp.refus', { rule: outcome.rule, code: outcome.code, tool: tool.name });
    return toolResult(id, outcome);
  }

  private async agentTool(viewer: Viewer, name: string, a: Record<string, unknown>): Promise<ToolOutcome> {
    // Le serveur MCP n'agit que pour un agent : la direction, la conformité et les partenaires n'y ont aucun outil.
    if (viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'role' };
    const { acces, brouillons, db } = this.deps;
    switch (name) {
      case 'mes_biens': {
        const rows = await db.all<{ id: string }>('SELECT id FROM properties WHERE network_id = ? AND agent_id = ? ORDER BY reference, id LIMIT 200', [viewer.networkId, viewer.userId]);
        const out: Json[] = [];
        for (const row of rows) {
          // Chaque bien repasse par les droits, et chaque lecture va au journal [R16].
          const read = await acces.readProperty(viewer, row.id);
          if (!read.ok) {
            if (read.code === 'agent_inactive') return { ok: false, rule: 'R16', code: read.code };
            continue;
          }
          if (read.view === 'full') out.push(toolProperty(read.value, 'full') as unknown as Json);
        }
        return { ok: true, value: { biens: out } };
      }
      case 'lire_bien': {
        const read = await acces.readProperty(viewer, a.bien as string);
        if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
        return { ok: true, value: { bien: toolProperty(read.value, read.view) as unknown as Json } };
      }
      case 'mes_brouillons': {
        const list = await brouillons.listOwn(viewer);
        if (!list.ok) return list;
        return { ok: true, value: { brouillons: list.value.map(draftJson) } };
      }
      case 'brouillon_note': {
        const d = await brouillons.draftNote(viewer, a.fiche, a.texte);
        // Le texte de la note ne repart pas vers l'assistant : il l'a écrit, l'identifiant suffit.
        return d.ok ? { ok: true, value: { brouillon: d.value.id, statut: d.value.status, a_valider_dans: 'application' } } : d;
      }
      case 'brouillon_prix': {
        const d = await brouillons.draftPrice(viewer, a.bien, a.prix_eur);
        return d.ok ? { ok: true, value: { brouillon: d.value.id, statut: d.value.status, a_valider_dans: 'application' } } : d;
      }
      default:
        return { ok: false, rule: 'R590', code: 'unknown_tool' };
    }
  }

  /**
   * Les biens diffusables d'un réseau [R592] : la dernière annonce publiée, en vente ou sous offre, d'un bien encore
   * disponible dans le socle, que la porte de diffusion accepte à l'instant même [R42]. Le même ordre pour tous, du
   * plus récent au plus ancien [R14] ; 50 au plus. Rien d'autre que ce que dit l'annonce : ni agent, ni adresse [R46].
   */
  async publicListings(networkId: string, commune: unknown): Promise<ToolOutcome> {
    if (commune !== undefined && (typeof commune !== 'string' || commune.trim() === '' || commune.length > 80)) return { ok: false, rule: 'R592', code: 'bad_input' };
    const wanted = typeof commune === 'string' ? fold(commune) : null;
    const at = this.now();
    const candidates = (await this.deps.published.published(networkId))
      .filter((l) => (l.state === 'en_vente' || l.state === 'sous_offre') && LISTABLE_STATUSES.includes(l.propertyStatus) && l.propertyStatus !== 'draft')
      .filter((l) => wanted === null || (l.city !== null && fold(l.city) === wanted))
      .sort((x, y) => (y.day ?? '').localeCompare(x.day ?? '') || x.propertyId.localeCompare(y.propertyId));
    const out: PublicListing[] = [];
    for (const l of candidates) {
      if (out.length >= PUBLIC_LISTINGS_MAX) break;
      if (!(await this.deps.gate.canDiffuse(networkId, l.propertyId, at)).allowed) continue;
      out.push({ bien: l.propertyId, titre: l.title, prix_eur: l.priceEur, etat: l.state, commune: l.city, mentions: l.mentions });
    }
    return { ok: true, value: { controle_a: at.toISOString(), biens: out as unknown as Json } };
  }

  /** Le serveur MCP n'agit que pour un agent en activité de son réseau, même pour la lecture publique [R16, R86]. */
  private async activeAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    const agent = await this.deps.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return false;
    return (await agentState(this.deps.db, viewer.networkId, viewer.userId, this.now())) !== 'parti';
  }

  private async log(caller: McpCaller, type: string, data: Record<string, string>): Promise<void> {
    const actor = caller.kind === 'agent' ? `${String(caller.viewer.role)}:${caller.viewer.userId}` : 'public:mcp';
    await appendEvent(this.deps.journal, { type, actor, subject: null, data }, this.now);
  }
}

/** Les arguments ne portent que les clés de l'outil, toutes celles requises, chacune du bon type. */
function argsMatch(tool: ToolDef, args: Record<string, unknown>): boolean {
  const keys = Object.keys(args);
  if (keys.some((k) => !Object.hasOwn(tool.inputSchema.properties, k))) return false;
  if (tool.inputSchema.required.some((k) => !Object.hasOwn(args, k))) return false;
  for (const k of keys) {
    const schema = tool.inputSchema.properties[k] as { type: string };
    const v = args[k];
    if (schema.type === 'string' && typeof v !== 'string') return false;
    if (schema.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v))) return false;
    if (schema === ID_SCHEMA && !ARG_ID.test(v as string)) return false;
  }
  return true;
}

export function toolProperty(p: Property, view: 'full' | 'shared'): ToolProperty {
  return {
    bien: p.id,
    reference: p.reference,
    type: p.kind,
    commune: p.city,
    code_postal: p.postal_code,
    surface_m2: p.surface_m2,
    pieces: p.rooms,
    prix_fiche_eur: p.price_eur,
    statut: p.status,
    vue: view === 'full' ? 'complete' : 'fichier_commun',
  };
}

function draftJson(d: Draft): Json {
  return {
    brouillon: d.id,
    type: d.kind,
    sujet: d.subject,
    // Le texte d'une note ne repart jamais vers l'assistant : il peut parler du client [R590].
    ...('priceEur' in d.content ? { prix_eur: d.content.priceEur } : {}),
    statut: d.status,
    cree_le: d.createdAt,
    decide_le: d.decidedAt,
  };
}

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const rpcResult = (id: string | number, result: Json): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Le résultat d'un outil, au format MCP : le texte JSON et sa forme structurée ; un refus porte `isError`. */
function toolResult(id: string | number, outcome: ToolOutcome): JsonRpcResponse {
  const structured: Json = outcome.ok ? outcome.value : { refus: { regle: outcome.rule, code: outcome.code } };
  return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: !outcome.ok });
}

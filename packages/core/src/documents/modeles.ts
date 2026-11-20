/**
 * La bibliothèque de modèles et la génération des documents (M06, D02).
 *
 * Un modèle est un texte daté et versionné, avec ses champs `{{nom.du.champ}}` pris dans un catalogue fermé. Il ne
 * change jamais : le modifier crée une version. Il naît « essai » ; seule une personne désignée, avec le rôle
 * conformité, le passe « validé » (H08), jamais le code. Un document généré remplit chaque champ depuis la base, ou
 * depuis une saisie de l'agent pour les seuls champs prévus pour cela ; un champ qui manque est montré comme tel et
 * rend le document « incomplet », jamais un texte inventé. L'IA ne rédige rien [R40].
 *
 * Le document garde la version et l'empreinte du modèle utilisé, et son propre contenu, figé. Un modèle « essai » ne
 * produit qu'un document d'essai, marqué comme tel, qu'aucune signature réelle n'acceptera. Les droits sont ceux de la
 * fiche et du bien [R16] ; le journal ne porte que des identifiants et des nombres [R13].
 */
import { PRINT_DESIGN_CSS } from '../design/systeme.ts';
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { localTime } from '../envoi/horaires.ts';
import { mandateEndDay, mandateExpired, mandateTerms } from './conditions.ts';
import { POWER_KINDS, documentMandants, documentPersons, type PowerKind } from './controles.ts';
import { MANDATE_DESIGNATION_FIELDS, formatAddress, formatParcels, latestDesignation, latestDomicile } from './designation.ts';

/** Prénom et nom : l'un sans l'autre ne suffit pas à identifier un mandant. */
function fullName(first: string | null | undefined, last: string | null | undefined): string | null {
  const f = first?.trim() ?? '';
  const l = last?.trim() ?? '';
  return f && l ? `${f} ${l}` : null;
}

/** « A », « A et B », « A, B et C » ; null si un seul nom manque. */
function namesOf(names: (string | null)[]): string | null {
  if (names.some((n) => n === null)) return null;
  const all = names as string[];
  return all.length <= 1 ? (all[0] ?? null) : `${all.slice(0, -1).join(', ')} et ${all[all.length - 1]}`;
}

export const DOCUMENT_KINDS = ['mandat_vente_simple', 'mandat_vente_exclusif', 'avenant_mandat'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** D'où vient la valeur d'un champ : la base, une saisie de l'agent, ou la signature (rempli plus tard). */
export type FieldSource = 'base' | 'saisie' | 'signature';
export const TEMPLATE_FIELDS: Readonly<Record<string, { source: FieldSource; label: string }>> = Object.freeze({
  'mandant.nom': { source: 'base', label: 'nom du mandant' },
  'bien.reference': { source: 'base', label: 'référence du bien' },
  'bien.type': { source: 'base', label: 'type de bien' },
  'bien.commune': { source: 'base', label: 'commune du bien' },
  'bien.surface': { source: 'base', label: 'surface du bien' },
  'bien.pieces': { source: 'base', label: 'nombre de pièces' },
  'bien.prix': { source: 'base', label: 'prix du bien' },
  // AU002 : la désignation du bien et le domicile de chaque mandant, repris en champs depuis la base.
  'bien.adresse': { source: 'base', label: 'adresse du bien' },
  'bien.cadastre': { source: 'base', label: 'désignation cadastrale du bien' },
  'mandant.domicile': { source: 'base', label: 'domicile du mandant' },
  'agent.nom': { source: 'base', label: 'nom de l’agent' },
  'reseau.nom': { source: 'base', label: 'nom du réseau' },
  'document.date': { source: 'base', label: 'date du document' },
  'honoraires.montant': { source: 'saisie', label: 'montant des honoraires' },
  'honoraires.charge': { source: 'saisie', label: 'charge des honoraires' },
  'mandat.duree_mois': { source: 'saisie', label: 'durée du mandat' },
  'registre.numero': { source: 'signature', label: 'numéro au registre' },
  'signature.date': { source: 'signature', label: 'date de signature' },
  'signature.lieu': { source: 'signature', label: 'lieu de signature' },
  'mandat.numero': { source: 'base', label: 'numéro du mandat au registre' },
  'avenant.objet': { source: 'base', label: 'objet de l’avenant' },
  'avenant.prix': { source: 'saisie', label: 'nouveau prix' },
  'avenant.duree_mois': { source: 'saisie', label: 'nouvelle durée du mandat' },
  // AU057 · un avenant change aussi les honoraires, leur charge et le type du mandat, à une date d'effet.
  'avenant.honoraires': { source: 'saisie', label: 'nouveaux honoraires' },
  'avenant.honoraires_charge': { source: 'saisie', label: 'nouvelle charge des honoraires' },
  'avenant.type': { source: 'saisie', label: 'nouveau type de mandat' },
  'avenant.date_effet': { source: 'saisie', label: 'date d’effet de l’avenant' },
});

/** Les saisies d'un avenant (AU057) : chacune a sa place, ou passe par l'objet de l'avenant. */
export const AMENDMENT_INPUTS = ['avenant.prix', 'avenant.duree_mois', 'avenant.honoraires', 'avenant.honoraires_charge', 'avenant.type', 'avenant.date_effet'] as const;
/** Le type d'un mandat de vente, que l'avenant peut changer (AU057). */
export type MandateType = 'simple' | 'exclusif';

export interface TemplateInfo {
  id: string;
  kind: DocumentKind;
  version: number;
  status: 'essai' | 'valide';
  body: string;
  fields: string[];
  hash: string;
  createdAt: string;
  validatedBy: string | null;
  validatedAt: string | null;
}

export interface GeneratedDocument {
  id: string;
  kind: DocumentKind;
  mode: 'essai' | 'reel';
  status: 'complet' | 'incomplet';
  /** Les champs qui manquent, par leur nom. */
  missing: string[];
  templateId: string;
  templateVersion: number;
  templateHash: string;
  content: string;
  contentHash: string;
  createdAt: string;
}

/** Les faits d'un document gardés pour les contrôles : prix du bien, honoraires, qui les paie, durée. */
export interface DocumentFacts {
  priceEur: number | null;
  feeEur: number | null;
  feeCharge: 'vendeur' | 'acquereur' | null;
  durationMonths: number | null;
  /** Pour un avenant : le mandat modifié. Ses prix et durée sont alors les nouveaux, s'ils changent. */
  mandateId?: string | null;
  /**
   * Pour un avenant (AU057) : vrai s'il change le montant des honoraires (`feeEur` est alors le nouveau), ou leur charge
   * (`feeCharge` est alors la nouvelle). Sinon, la valeur gardée n'est qu'une copie de la préparation, jamais appliquée.
   */
  feeChanged?: boolean;
  feeChargeChanged?: boolean;
  /** Pour un avenant (AU057) : le nouveau type du mandat, s'il change. */
  mandateType?: MandateType;
  /** Pour un avenant (AU057) : le jour, `AAAA-MM-JJ` à Paris, où il prend effet ; absent, le jour de sa signature. */
  effectiveOn?: string;
  /** Pour un avenant (AU057) : le prix en vigueur à sa préparation, pour contrôler de nouveaux honoraires au barème. */
  priceInForceEur?: number | null;
}

/**
 * Une partie ajoutée au document par un autre module (le questionnaire de HX33) : du HTML déjà échappé, son style en
 * jetons du système de design, ce qui y manque, et si elle est d'essai. Elle reçoit le prix lu dans la base.
 */
export type DocumentAnnex = (ctx: { priceEur: number | null; templateValidated: boolean }) => Promise<{ html: string; css: string; missing: string[]; trial: boolean }>;

export interface GenerateRequest {
  kind: DocumentKind;
  personId: string;
  propertyId: string;
  /** Les champs saisis par l'agent : honoraires et durée ; pour un avenant, nouveau prix et nouvelle durée. */
  inputs?: {
    'honoraires.montant'?: unknown;
    'honoraires.charge'?: unknown;
    'mandat.duree_mois'?: unknown;
    'avenant.prix'?: unknown;
    'avenant.duree_mois'?: unknown;
    'avenant.honoraires'?: unknown;
    'avenant.honoraires_charge'?: unknown;
    'avenant.type'?: unknown;
    'avenant.date_effet'?: unknown;
  };
  /** Pour un avenant : le mandat signé et numéroté qu'il modifie. */
  mandateId?: string;
  /**
   * Les autres mandants d'un mandat de vente (couple, indivision) : chacun avec sa propre fiche, jamais réunie à celle
   * du premier (AU001). Le document les nomme tous ; chacun est identifié et signe [R41]. Un avenant reprend ceux du
   * mandat qu'il modifie.
   */
  coMandantIds?: string[];
  /**
   * Les mandants représentés par procuration (AU059) : le mandant (le premier ou un autre mandant), son représentant
   * (une autre fiche, vue en entier, qui n'est pas un mandant), la sorte de procuration, son jour, et son scan rangé
   * avec ceux du mandat du bien. Le document nomme la partie et son représentant ; le représentant signe pour elle.
   */
  proxies?: ProxyInput[];
  /**
   * Le droit de chaque mandant sur le bien (AU060) : pleine propriété, usufruit ou nue-propriété. Donné pour un mandant,
   * il l'est pour tous ; un bien démembré se vend par l'usufruitier et les nus-propriétaires ensemble, chacun avec le
   * justificatif de son droit, rangé avec les scans du mandat.
   */
  rights?: RightInput[];
}

export const RIGHT_KINDS = ['pleine_propriete', 'usufruit', 'nue_propriete'] as const;
export type RightKind = (typeof RIGHT_KINDS)[number];
export interface RightInput {
  personId: string;
  right: RightKind;
  /** Le justificatif du droit démembré (acte, attestation du notaire), déposé comme le scan du mandat. */
  proofRef?: string;
}
const RIGHT_LABEL: Record<RightKind, string> = { pleine_propriete: 'titulaire de la pleine propriété', usufruit: 'titulaire de l’usufruit', nue_propriete: 'titulaire de la nue-propriété' };

export interface ProxyInput {
  mandantId: string;
  proxyId: string;
  powerKind: PowerKind;
  /** Le jour de la procuration, `AAAA-MM-JJ`. */
  grantedOn: string;
  /** Le scan de la procuration, déposé comme celui du mandat : `mandats/<bien>/<identifiant>.<ext>`. */
  powerRef: string;
}
const POWER_LABEL: Record<PowerKind, string> = { notariee: 'notariée', sous_seing_prive: 'sous seing privé' };
const POWER_REF = /^mandats\/([A-Za-z0-9_-]{1,64})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|jpg|png)$/;


/** Au plus dix mandants par document : le premier et neuf autres. */
export const MAX_CO_MANDANTS = 9;

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R40' | null; code: 'unknown_kind' | 'unknown_field' | 'no_evidence' | 'no_number_field' | 'empty_body' | 'body_too_long' | 'no_template' | 'not_essai' | 'bad_input' | 'unknown_template' | 'bad_mandate' | 'bad_co_mandants' | 'no_designation_field' | 'bad_proxies' | 'bad_rights' | 'dismembered_incomplete' };

const PLACEHOLDER = /\{\{\s*([a-z_.]+)\s*\}\}/g;
const MAX_BODY = 50_000;
const TIME_ZONE = 'Europe/Paris';

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Les champs d'un texte de modèle, dans l'ordre de leur première apparition. */
export function templateFields(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Les documents suivent le système de design d'AIMMO pour le papier (Z03), en jetons seulement [R201]. */
const PRINT_CSS =
  PRINT_DESIGN_CSS +
  'body{font:12pt/1.5 var(--police-titre);max-width:42rem;margin:2rem auto;padding:0 1rem}p{margin:0 0 .8em}.evidence{border:2px solid var(--encre);padding:.6em;font-weight:bold}.essai{border:3px dashed var(--danger);color:var(--danger);padding:.6em;font-weight:bold}.manque{background:var(--moutarde);color:var(--sur-moutarde)}.a-signer{font-style:italic}@media print{body{margin:0}}';

/**
 * Le document rendu en HTML imprimable. Le texte du modèle et chaque valeur sont échappés ; un champ absent est
 * montré « à compléter », un champ de signature « à la signature » ; un document d'essai porte un bandeau.
 */
export function renderDocument(
  body: string,
  values: Readonly<Record<string, string | null>>,
  options: { title: string; trial: boolean; fields?: Readonly<Record<string, { source: FieldSource; label: string }>> },
): string {
  const registry = options.fields ?? TEMPLATE_FIELDS;
  const paragraphs = body.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const html = paragraphs
    .map((paragraph) => {
      const evidence = paragraph.startsWith('!! ');
      const text = evidence ? paragraph.slice(3) : paragraph;
      let out = '';
      let last = 0;
      for (const m of text.matchAll(PLACEHOLDER)) {
        out += escapeHtml(text.slice(last, m.index));
        const name = m[1]!;
        const field = registry[name]!;
        const value = values[name];
        if (field.source === 'signature') out += `<span class="a-signer">[${escapeHtml(field.label)} à la signature]</span>`;
        else if (value === null || value === undefined) out += `<span class="manque">[à compléter : ${escapeHtml(field.label)}]</span>`;
        else out += escapeHtml(value);
        last = m.index + m[0].length;
      }
      out += escapeHtml(text.slice(last));
      out = out.replace(/\n/g, '<br>');
      return evidence ? `<p class="evidence">${out}</p>` : `<p>${out}</p>`;
    })
    .join('\n');
  const banner = options.trial ? '<p class="essai">DOCUMENT D’ESSAI : modèle non validé, sans aucune valeur juridique.</p>\n' : '';
  return `<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(options.title)}</title>\n<style>${PRINT_CSS}</style>\n</head>\n<body>\n${banner}${html}\n</body>\n</html>\n`;
}

export const signatureSpan = (name: string): string => `<span class="a-signer">[${escapeHtml(TEMPLATE_FIELDS[name]!.label)} à la signature]</span>`;

/**
 * L'exemplaire signé : chaque champ de signature du document (numéro au registre, date, lieu) prend sa valeur, échappée.
 * Le reste du document ne change pas, au caractère près.
 */
export function fillSignatureFields(content: string, values: Readonly<Record<'registre.numero' | 'signature.date' | 'signature.lieu', string>>): string {
  let out = content;
  for (const [name, value] of Object.entries(values)) out = out.split(signatureSpan(name)).join(`<span class="signe">${escapeHtml(value)}</span>`);
  return out;
}

/** Une signature réelle n'accepte qu'un document complet, fait sur un modèle validé [R40]. */
export const canSignForReal = (doc: Pick<GeneratedDocument, 'mode' | 'status'>): boolean => doc.mode === 'reel' && doc.status === 'complet';

const KIND_TITLE: Record<DocumentKind, string> = {
  mandat_vente_simple: 'Mandat de vente simple',
  mandat_vente_exclusif: 'Mandat de vente exclusif',
  avenant_mandat: 'Avenant au mandat',
};
const PROPERTY_KIND: Record<string, string> = { home: 'logement', land: 'terrain', building: 'immeuble', commercial: 'local commercial', business_walls: 'murs commerciaux', business: 'fonds de commerce' };
const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

interface TemplateRow {
  id: string;
  network_id: string;
  kind: DocumentKind;
  version: number;
  status: 'essai' | 'valide';
  body: string;
  fields: string;
  hash: string;
  created_at: string;
  validated_by: string | null;
  validated_at: string | null;
}

const toTemplate = (r: TemplateRow): TemplateInfo => ({
  id: r.id,
  kind: r.kind,
  version: Number(r.version),
  status: r.status,
  body: r.body,
  fields: JSON.parse(r.fields) as string[],
  hash: r.hash,
  createdAt: r.created_at,
  validatedBy: r.validated_by,
  validatedAt: r.validated_at,
});

export class Modeles {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string, subject: string | null = null): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Une nouvelle version d'un modèle, à l'état « essai » : la direction seule. */
  async createVersion(viewer: Viewer, kind: DocumentKind, body: string): Promise<{ ok: true; template: TemplateInfo } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'template', 'role');
    if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) return { ok: false, rule: null, code: 'unknown_kind' };
    if (typeof body !== 'string' || body.trim() === '') return { ok: false, rule: null, code: 'empty_body' };
    if (body.length > MAX_BODY) return { ok: false, rule: null, code: 'body_too_long' };
    const fields = templateFields(body);
    if (fields.some((f) => !TEMPLATE_FIELDS[f])) return { ok: false, rule: 'R40', code: 'unknown_field' };
    // Un champ mal écrit (accolades sans nom reconnu) serait recopié tel quel : refusé.
    if (/\{\{|\}\}/.test(body.replace(PLACEHOLDER, ''))) return { ok: false, rule: 'R40', code: 'unknown_field' };
    // Le numéro du registre figure sur l'exemplaire du mandant : tout mandat de vente en porte le champ [R39].
    if (kind !== 'avenant_mandat' && !fields.includes('registre.numero')) return { ok: false, rule: 'R40', code: 'no_number_field' };
    // Un mandat de vente désigne le bien (adresse, cadastre) et le domicile de chaque mandant, en champs (AU002) [R40].
    if (kind !== 'avenant_mandat' && MANDATE_DESIGNATION_FIELDS.some((f) => !fields.includes(f))) return { ok: false, rule: 'R40', code: 'no_designation_field' };
    // Un avenant porte la référence du mandat qu'il modifie : son numéro au registre.
    if (kind === 'avenant_mandat' && !fields.includes('mandat.numero')) return { ok: false, rule: 'R40', code: 'no_number_field' };
    // Un mandat exclusif met sa clause d'exclusivité en évidence : un paragraphe qui commence par `!! `.
    if (kind === 'mandat_vente_exclusif' && !body.replace(/\r\n?/g, '\n').split(/\n{2,}/).some((p) => p.startsWith('!! '))) return { ok: false, rule: 'R40', code: 'no_evidence' };
    const hash = await sha256(JSON.stringify([kind, body, fields]));
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM document_templates WHERE network_id = ? AND kind = ?', [viewer.networkId, kind]);
      const version = Number(last?.v ?? 0) + 1;
      const id = this.newId();
      const at = this.now().toISOString();
      const { changes } = await this.db.run(
        `INSERT INTO document_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at) VALUES (?, ?, ?, ?, 'essai', ?, ?, ?, ?, ?)
         ON CONFLICT (network_id, kind, version) DO NOTHING`,
        [id, viewer.networkId, kind, version, body, JSON.stringify(fields), hash, this.actor(viewer), at],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'modele.version', actor: this.actor(viewer), subject: `template:${id}`, data: { kind, version } }, this.now);
      const row = await this.db.first<TemplateRow>('SELECT * FROM document_templates WHERE id = ?', [id]);
      return { ok: true, template: toTemplate(row!) };
    }
    throw new Error('template_version_busy');
  }

  /** Le modèle passe « validé » : la conformité seule, qui note qui l'a validé (H08). Le code ne valide jamais seul. */
  async validate(viewer: Viewer, templateId: string): Promise<{ ok: true; template: TemplateInfo } | Refusal | Problem> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'template', 'role', `template:${templateId}`);
    const row = await this.db.first<TemplateRow>('SELECT * FROM document_templates WHERE id = ? AND network_id = ?', [templateId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown_template' };
    if (row.status !== 'essai') return { ok: false, rule: null, code: 'not_essai' };
    const at = this.now().toISOString();
    await this.db.run(`UPDATE document_templates SET status = 'valide', validated_by = ?, validated_at = ? WHERE id = ? AND status = 'essai'`, [this.actor(viewer), at, templateId]);
    await appendEvent(this.journal, { type: 'modele.valide', actor: this.actor(viewer), subject: `template:${templateId}`, data: { kind: row.kind, version: Number(row.version) } }, this.now);
    return { ok: true, template: toTemplate((await this.db.first<TemplateRow>('SELECT * FROM document_templates WHERE id = ?', [templateId]))!) };
  }

  /** Les modèles du réseau, toutes versions : lisibles par tout rôle du réseau, sans donnée de client. */
  async list(viewer: Viewer): Promise<{ ok: true; templates: TemplateInfo[] } | Refusal> {
    if (!['agent', 'direction', 'compliance'].includes(viewer.role)) return this.refuse(viewer, 'template', 'role');
    const rows = await this.db.all<TemplateRow>('SELECT * FROM document_templates WHERE network_id = ? ORDER BY kind, version', [viewer.networkId]);
    return { ok: true, templates: rows.map(toTemplate) };
  }

  /** Génère un document depuis la dernière version du modèle, pour une fiche et un bien que l'on voit en entier [R16]. */
  async generate(viewer: Viewer, request: GenerateRequest, annex?: DocumentAnnex): Promise<{ ok: true; document: GeneratedDocument } | Refusal | Problem> {
    if (!(DOCUMENT_KINDS as readonly string[]).includes(request.kind)) return { ok: false, rule: null, code: 'unknown_kind' };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'document', 'role');
    const inputs = readInputs(request.inputs ?? {});
    if (inputs === null) return { ok: false, rule: null, code: 'bad_input' };

    const read = await this.acces.readFiche(viewer, request.personId);
    if (!read.ok) return read;
    if (read.view !== 'full') return this.refuse(viewer, 'person', 'not_assigned', `person:${request.personId}`);
    const fiche = read.value;
    // Le bien passe par la lecture sous droits : la lecture est écrite au journal avant d'être rendue [R16].
    const readProperty = await this.acces.readProperty(viewer, request.propertyId);
    if (!readProperty.ok) return readProperty;
    if (readProperty.view !== 'full') return this.refuse(viewer, 'property', 'not_assigned', `property:${request.propertyId}`);
    const property = readProperty.value;

    // Le modèle en vigueur : la dernière version validée ; tant qu'aucune ne l'est, la dernière version d'essai, qui ne
    // donne qu'un document d'essai. Une nouvelle version d'essai ne remplace jamais une version validée.
    const template =
      (await this.db.first<TemplateRow>(`SELECT * FROM document_templates WHERE network_id = ? AND kind = ? AND status = 'valide' ORDER BY version DESC LIMIT 1`, [viewer.networkId, request.kind])) ??
      (await this.db.first<TemplateRow>('SELECT * FROM document_templates WHERE network_id = ? AND kind = ? ORDER BY version DESC LIMIT 1', [viewer.networkId, request.kind]));
    if (!template) return { ok: false, rule: 'R40', code: 'no_template' };

    // Un avenant se rattache à un mandat signé, numéroté, en cours, du même mandant et du même bien.
    let linked: { id: string; number: string; facts: DocumentFacts | null } | null = null;
    if (template.kind === 'avenant_mandat') {
      if (typeof request.mandateId !== 'string') return { ok: false, rule: null, code: 'bad_mandate' };
      linked = await this.mandateInForce(viewer.networkId, request.mandateId, fiche.members.map((m) => m.id), property.id);
      if (!linked) return { ok: false, rule: null, code: 'bad_mandate' };
    } else if (request.mandateId !== undefined) return { ok: false, rule: null, code: 'bad_mandate' };

    // Les autres mandants : des fiches distinctes, vues en entier, jamais celle du premier ni deux fois la même [R16].
    // Un avenant reprend ceux du mandat qu'il modifie, sans en changer.
    let coMandants: { id: string; name: string | null; memberIds: string[] }[] = [];
    if (template.kind === 'avenant_mandat') {
      if (request.coMandantIds !== undefined) return { ok: false, rule: null, code: 'bad_co_mandants' };
      // Chacun relu sous droits, comme au mandat : une fiche confiée depuis à un autre agent arrête l'avenant [R16].
      for (const id of await this.coMandantsOfMandate(linked!.id)) {
        const co = await this.acces.readFiche(viewer, id);
        if (!co.ok) return co;
        if (co.view !== 'full') return this.refuse(viewer, 'person', 'not_assigned', `person:${id}`);
        coMandants.push({ id, name: fullName(co.value.person.first_name, co.value.person.last_name), memberIds: co.value.members.map((m) => m.id) });
      }
    } else if (request.coMandantIds !== undefined) {
      const ids = request.coMandantIds;
      if (!Array.isArray(ids) || ids.length > MAX_CO_MANDANTS || ids.some((id) => typeof id !== 'string' || id === '')) return { ok: false, rule: null, code: 'bad_co_mandants' };
      const seen = new Set(fiche.members.map((m) => m.id));
      for (const id of ids) {
        const co = await this.acces.readFiche(viewer, id);
        if (!co.ok) return co;
        if (co.view !== 'full') return this.refuse(viewer, 'person', 'not_assigned', `person:${id}`);
        // Une fiche réunie à celle du premier mandant, ou déjà nommée, n'est pas un autre mandant.
        if (co.value.members.some((m) => seen.has(m.id))) return { ok: false, rule: null, code: 'bad_co_mandants' };
        for (const m of co.value.members) seen.add(m.id);
        coMandants.push({ id: co.value.person.id, name: fullName(co.value.person.first_name, co.value.person.last_name), memberIds: co.value.members.map((m) => m.id) });
      }
    }

    // Les procurations (AU059) : chacune pour un mandant du document, une fois ; le représentant est une autre fiche,
    // vue en entier, qui n'est ni un mandant ni réunie à l'un d'eux [R16, R41].
    const proxies: (ProxyInput & { proxyName: string | null; memberIds: string[] })[] = [];
    if (request.proxies !== undefined) {
      const list = request.proxies;
      const mandantRoots = [fiche.person.id, ...coMandants.map((c) => c.id)];
      const mandantMembers = new Set([...fiche.members.map((m) => m.id), ...coMandants.flatMap((c) => c.memberIds)]);
      const today = localTime(this.now(), TIME_ZONE).date;
      if (!Array.isArray(list) || list.length === 0 || list.length > mandantRoots.length) return { ok: false, rule: null, code: 'bad_proxies' };
      for (const raw of list as unknown[]) {
        const p = raw as Partial<ProxyInput> | null;
        if (!p || typeof p !== 'object' || Object.keys(p).some((k) => !['mandantId', 'proxyId', 'powerKind', 'grantedOn', 'powerRef'].includes(k))) return { ok: false, rule: null, code: 'bad_proxies' };
        if (typeof p.mandantId !== 'string' || !mandantRoots.includes(p.mandantId) || proxies.some((q) => q.mandantId === p.mandantId)) return { ok: false, rule: null, code: 'bad_proxies' };
        if (typeof p.powerKind !== 'string' || !(POWER_KINDS as readonly string[]).includes(p.powerKind)) return { ok: false, rule: null, code: 'bad_proxies' };
        const granted = typeof p.grantedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.grantedOn) ? new Date(`${p.grantedOn}T12:00:00Z`) : null;
        if (!granted || Number.isNaN(granted.getTime()) || granted.toISOString().slice(0, 10) !== p.grantedOn || p.grantedOn! > today) return { ok: false, rule: null, code: 'bad_proxies' };
        // Le scan de la procuration est rangé avec ceux du mandat de ce bien, jamais d'un autre.
        const ref = typeof p.powerRef === 'string' ? POWER_REF.exec(p.powerRef) : null;
        if (!ref || ref[1] !== property.id) return { ok: false, rule: null, code: 'bad_proxies' };
        if (typeof p.proxyId !== 'string' || p.proxyId === '') return { ok: false, rule: null, code: 'bad_proxies' };
        const proxy = await this.acces.readFiche(viewer, p.proxyId);
        if (!proxy.ok) return proxy;
        if (proxy.view !== 'full') return this.refuse(viewer, 'person', 'not_assigned', `person:${p.proxyId}`);
        if (proxy.value.members.some((m) => mandantMembers.has(m.id))) return { ok: false, rule: null, code: 'bad_proxies' };
        // Un représentant pour un seul mandant : chacun reçoit son code et son exemplaire, jamais en double.
        if (proxies.some((q) => q.proxyId === proxy.value.person.id)) return { ok: false, rule: null, code: 'bad_proxies' };
        proxies.push({
          mandantId: p.mandantId,
          proxyId: proxy.value.person.id,
          powerKind: p.powerKind as PowerKind,
          grantedOn: p.grantedOn,
          powerRef: p.powerRef!,
          proxyName: fullName(proxy.value.person.first_name, proxy.value.person.last_name),
          memberIds: proxy.value.members.map((m) => m.id),
        });
      }
    }
    // Les droits des mandants (AU060) : tous ou aucun ; un usufruit ne se vend pas sans la nue-propriété, ni l'inverse ;
    // un droit démembré a son justificatif, rangé avec les scans du mandat de ce bien.
    const rights: RightInput[] = [];
    if (request.rights !== undefined) {
      const list = request.rights;
      const roots = [fiche.person.id, ...coMandants.map((c) => c.id)];
      if (!Array.isArray(list) || list.length !== roots.length) return { ok: false, rule: null, code: 'bad_rights' };
      for (const raw of list as unknown[]) {
        const r = raw as Partial<RightInput> | null;
        if (!r || typeof r !== 'object' || Object.keys(r).some((k) => !['personId', 'right', 'proofRef'].includes(k))) return { ok: false, rule: null, code: 'bad_rights' };
        if (typeof r.personId !== 'string' || !roots.includes(r.personId) || rights.some((x) => x.personId === r.personId)) return { ok: false, rule: null, code: 'bad_rights' };
        if (typeof r.right !== 'string' || !(RIGHT_KINDS as readonly string[]).includes(r.right)) return { ok: false, rule: null, code: 'bad_rights' };
        const split = r.right !== 'pleine_propriete';
        const ref = typeof r.proofRef === 'string' ? POWER_REF.exec(r.proofRef) : null;
        if (split ? !ref || ref[1] !== property.id : r.proofRef !== undefined && (!ref || ref[1] !== property.id)) return { ok: false, rule: null, code: 'bad_rights' };
        rights.push({ personId: r.personId, right: r.right as RightKind, ...(r.proofRef !== undefined ? { proofRef: r.proofRef } : {}) });
      }
      const has = (k: RightKind) => rights.some((x) => x.right === k);
      if (has('usufruit') !== has('nue_propriete')) return { ok: false, rule: null, code: 'dismembered_incomplete' };
    }
    // Le nom d'un mandant représenté dit son représentant et la procuration ; un représentant sans nom rend le champ manquant.
    // Son droit sur le bien suit son nom, s'il est dit (AU060).
    const titled = (id: string, name: string | null): string | null => {
      const r = rights.find((x) => x.personId === id);
      return r && name !== null ? `${name}, ${RIGHT_LABEL[r.right]}` : name;
    };
    const represented = (id: string, bare: string | null): string | null => {
      const name = titled(id, bare);
      const p = proxies.find((q) => q.mandantId === id);
      if (!p || name === null) return name;
      if (p.proxyName === null) return null;
      return `${name}, ayant pour représentant ${p.proxyName} en vertu d’une procuration ${POWER_LABEL[p.powerKind]} du ${p.grantedOn.slice(8, 10)}/${p.grantedOn.slice(5, 7)}/${p.grantedOn.slice(0, 4)}`;
    };

    const agentId = viewer.role === 'agent' ? viewer.userId : (fiche.members.map((m) => m.agent_id).find((a) => a !== null) ?? property.agent_id);
    if (!agentId) return this.refuse(viewer, 'person', 'not_assigned', `person:${request.personId}`);
    const agent = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [viewer.networkId]);
    const text = (v: string | null | undefined): string | null => (v === null || v === undefined || v.trim() === '' ? null : v.trim());
    const day = localTime(this.now(), TIME_ZONE).date;
    // La désignation du bien et le domicile de chaque mandant, lus dans la base après les droits (AU002) [R16, R40].
    const designation = await latestDesignation(this.db, viewer.networkId, property.id);
    const mandantsOf = [{ name: fullName(fiche.person.first_name, fiche.person.last_name), memberIds: fiche.members.map((m) => m.id) }, ...coMandants];
    const domiciles = await Promise.all(mandantsOf.map(async (m) => ({ name: m.name, domicile: await latestDomicile(this.db, viewer.networkId, m.memberIds) })));
    // Un seul mandant : son domicile ; plusieurs : chacun nommé avec le sien. Un seul qui manque rend le champ manquant.
    const domicileText = domiciles.some((d) => d.domicile === null || (domiciles.length > 1 && d.name === null))
      ? null
      : domiciles.length === 1
        ? formatAddress(domiciles[0]!.domicile!)
        : domiciles.map((d) => `${d.name} : ${formatAddress(d.domicile!)}`).join(' ; ');
    const base: Record<string, string | null> = {
      // Le mandant est identifié par son prénom et son nom : l'un sans l'autre ne suffit pas.
      // Plusieurs mandants : tous nommés, dans l'ordre ; un seul nom qui manque rend le champ manquant.
      'mandant.nom': namesOf([represented(fiche.person.id, fullName(fiche.person.first_name, fiche.person.last_name)), ...coMandants.map((c) => represented(c.id, c.name))]),
      'bien.reference': text(property.reference),
      'bien.type': text(PROPERTY_KIND[property.kind] ?? null),
      'bien.commune': text([property.postal_code, property.city].filter(Boolean).join(' ')),
      'bien.surface': property.surface_m2 === null ? null : `${number.format(property.surface_m2)} m²`,
      'bien.pieces': property.rooms === null ? null : String(property.rooms),
      'bien.prix': property.price_eur === null ? null : `${number.format(property.price_eur)} €`,
      'bien.adresse': designation ? formatAddress(designation.address) : null,
      'bien.cadastre': designation ? formatParcels(designation.parcels) : null,
      'mandant.domicile': domicileText,
      'agent.nom': agent ? text(`${agent.first_name} ${agent.last_name}`) : null,
      'reseau.nom': text(network?.name),
      'document.date': `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`,
      'mandat.numero': linked ? linked.number : null,
      'avenant.objet': linked ? amendmentObject(inputs) : null,
      ...inputs,
    };
    // Les faits utiles aux contrôles avant signature (D03), tels qu'ils étaient à la génération.
    const raw = request.inputs ?? {};
    // Un avenant part des conditions en vigueur, avenants signés compris (AU057).
    const inForce = linked ? await mandateTerms(this.db, linked.id) : null;
    const newFee = typeof raw['avenant.honoraires'] === 'number' ? raw['avenant.honoraires'] : null;
    const newCharge = raw['avenant.honoraires_charge'] === 'vendeur' || raw['avenant.honoraires_charge'] === 'acquereur' ? raw['avenant.honoraires_charge'] : null;
    const newType = raw['avenant.type'] === 'simple' || raw['avenant.type'] === 'exclusif' ? raw['avenant.type'] : null;
    const effectiveOn = typeof raw['avenant.date_effet'] === 'string' ? raw['avenant.date_effet'] : null;
    if (linked) {
      // Une date d'effet se donne du jour même à un an ; un type de mandat qui ne change pas n'est pas un avenant.
      if (effectiveOn !== null && (effectiveOn < day || effectiveOn > mandateEndDay(this.now(), 12))) return { ok: false, rule: 'R40', code: 'bad_input' };
      // Ni après la fin du mandat en vigueur : un mandat échu ne reçoit plus d'avenant [R42].
      const signedRow = await this.db.first<{ signed_at: string }>('SELECT signed_at FROM signed_documents WHERE mandate_id = ? AND copy_content IS NOT NULL', [linked.id]);
      if (effectiveOn !== null && signedRow && typeof inForce?.durationMonths === 'number' && effectiveOn >= mandateEndDay(new Date(signedRow.signed_at), inForce.durationMonths)) return { ok: false, rule: 'R40', code: 'bad_input' };
      if (newType !== null && newType === inForce?.mandateType) return { ok: false, rule: 'R40', code: 'bad_input' };
      // Devenir exclusif : la clause d'exclusivité est mise en évidence sur l'avenant, comme sur un mandat exclusif.
      if (newType === 'exclusif' && !template.body.replace(/\r\n?/g, '\n').split(/\n{2,}/).some((p) => p.startsWith('!! '))) return { ok: false, rule: 'R40', code: 'no_evidence' };
    }
    const facts: DocumentFacts = linked
      ? {
          // Un avenant : les nouvelles conditions qu'il donne, et les honoraires en vigueur s'il n'y touche pas (AU057).
          priceEur: typeof raw['avenant.prix'] === 'number' ? raw['avenant.prix'] : null,
          feeEur: newFee ?? inForce?.feeEur ?? linked.facts?.feeEur ?? null,
          feeCharge: newCharge ?? inForce?.feeCharge ?? linked.facts?.feeCharge ?? null,
          durationMonths: typeof raw['avenant.duree_mois'] === 'number' ? raw['avenant.duree_mois'] : null,
          mandateId: linked.id,
          feeChanged: newFee !== null,
          feeChargeChanged: newCharge !== null,
          ...(newType !== null ? { mandateType: newType } : {}),
          ...(effectiveOn !== null ? { effectiveOn } : {}),
          priceInForceEur: inForce?.priceEur ?? linked.facts?.priceEur ?? null,
        }
      : {
          priceEur: property.price_eur ?? null,
          feeEur: typeof raw['honoraires.montant'] === 'number' ? raw['honoraires.montant'] : null,
          feeCharge: raw['honoraires.charge'] === 'vendeur' || raw['honoraires.charge'] === 'acquereur' ? raw['honoraires.charge'] : null,
          durationMonths: typeof raw['mandat.duree_mois'] === 'number' ? raw['mandat.duree_mois'] : null,
        };
    const fields = JSON.parse(template.fields) as string[];
    // Plusieurs mandants : le modèle doit les nommer tous, sinon le document ne dirait pas qui s'engage [R40, R41].
    if (coMandants.length > 0 && !fields.includes('mandant.nom')) return { ok: false, rule: 'R40', code: 'bad_co_mandants' };
    // Un mandant représenté : le modèle doit nommer la partie et son représentant (AU059) [R40, R41].
    if (proxies.length > 0 && !fields.includes('mandant.nom')) return { ok: false, rule: 'R40', code: 'bad_proxies' };
    // Des droits démembrés : le modèle doit nommer chaque mandant et son droit (AU060).
    if (rights.length > 0 && !fields.includes('mandant.nom')) return { ok: false, rule: 'R40', code: 'bad_rights' };
    // Toute saisie doit figurer sur le document signé ; pour un avenant, l'objet écrit tous les changements.
    const supplied = Object.entries(request.inputs ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
    const rendered = (k: string): boolean => fields.includes(k) || (template.kind === 'avenant_mandat' && fields.includes('avenant.objet') && (AMENDMENT_INPUTS as readonly string[]).includes(k));
    if (supplied.some((k) => !rendered(k))) return { ok: false, rule: 'R40', code: 'bad_input' };
    if (template.kind !== 'avenant_mandat' && supplied.some((k) => k.startsWith('avenant.'))) return { ok: false, rule: 'R40', code: 'bad_input' };
    // Un avenant ne change les conditions que par ses propres champs : les saisies du mandat n'y ont pas cours.
    if (template.kind === 'avenant_mandat' && supplied.some((k) => !k.startsWith('avenant.'))) return { ok: false, rule: 'R40', code: 'bad_input' };
    // Une annexe (le questionnaire de HX33) s'ajoute au document même : ce qui se signe est ce qu'elle montre, et une
    // annexe d'essai ou incomplète rend le document entier d'essai ou incomplet [R40, R442].
    const extra = annex ? await annex({ priceEur: facts.priceEur, templateValidated: template.status === 'valide' }) : null;
    // Un mandat de vente fait sur un modèle d'avant AU002, sans place pour la désignation, ne la porte pas : il reste
    // incomplet, et aucune signature réelle ne l'accepte [R40].
    const undesignated = template.kind === 'avenant_mandat' ? [] : MANDATE_DESIGNATION_FIELDS.filter((f) => !fields.includes(f));
    const missing = [...fields.filter((f) => TEMPLATE_FIELDS[f]?.source !== 'signature' && (base[f] === null || base[f] === undefined)), ...undesignated, ...(extra?.missing ?? [])];
    const mode = template.status === 'valide' && !extra?.trial ? 'reel' : 'essai';
    let content = renderDocument(template.body, base, { title: `${KIND_TITLE[template.kind]} · ${base['bien.reference'] ?? ''}`, trial: mode === 'essai' });
    if (extra) content = content.replace('</style>', `${extra.css}</style>`).replace('\n</body>', `\n${extra.html}\n</body>`);
    const contentHash = await sha256(content);
    const id = this.newId();
    const at = this.now().toISOString();
    const status = missing.length === 0 ? 'complet' : 'incomplet';
    await this.db.run(
      `INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, created_by, created_at, facts, mandate_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, template.id, Number(template.version), template.hash, template.kind, mode, status, JSON.stringify(missing), agentId, fiche.person.id, property.id, content, contentHash, this.actor(viewer), at, JSON.stringify(facts), linked?.id ?? null],
    );
    let position = 0;
    for (const co of coMandants) {
      await this.db.run('INSERT INTO document_co_mandants (document_id, person_id, network_id, position, added_at) VALUES (?, ?, ?, ?, ?)', [id, co.id, viewer.networkId, ++position, at]);
    }
    for (const r of rights) {
      await this.db.run(
        'INSERT INTO document_mandant_rights (document_id, network_id, person_id, right_kind, proof_ref, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, viewer.networkId, r.personId, r.right, r.proofRef ?? null, this.actor(viewer), at],
      );
    }
    for (const p of proxies) {
      await this.db.run(
        'INSERT INTO document_proxies (document_id, network_id, mandant_person_id, proxy_person_id, power_kind, granted_on, power_ref, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, viewer.networkId, p.mandantId, p.proxyId, p.powerKind, p.grantedOn, p.powerRef, this.actor(viewer), at],
      );
    }
    await appendEvent(
      this.journal,
      { type: 'document.genere', actor: this.actor(viewer), subject: `person:${fiche.person.id}`, data: { document: id, kind: template.kind, version: Number(template.version), mode, status, missing: missing.length, ...(coMandants.length > 0 ? { coMandants: coMandants.length } : {}), ...(proxies.length > 0 ? { proxies: proxies.length } : {}), ...(rights.length > 0 ? { rights: rights.map((r) => r.right) } : {}) } },
      this.now,
    );
    return {
      ok: true,
      document: { id, kind: template.kind, mode, status, missing, templateId: template.id, templateVersion: Number(template.version), templateHash: template.hash, content, contentHash, createdAt: at },
    };
  }

  /** Les autres mandants du document d'un mandat signé, dans leur ordre. */
  private async coMandantsOfMandate(mandateId: string): Promise<string[]> {
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT c.person_id FROM signed_documents s JOIN document_co_mandants c ON c.document_id = s.document_id WHERE s.mandate_id = ? ORDER BY c.position`,
      [mandateId],
    );
    return rows.map((r) => r.person_id);
  }

  /** Le mandat signé, numéroté, non annulé ni rétracté, du même mandant et du même bien ; ou null. */
  private async mandateInForce(networkId: string, mandateId: string, personIds: string[], propertyId: string): Promise<{ id: string; number: string; facts: DocumentFacts | null } | null> {
    const row = await this.db.first<{ id: string; person_id: string; property_id: string | null; number: string | null; facts: string | null; seq: number | null }>(
      `SELECT m.id, m.person_id, m.property_id, s.number, d.facts, r.seq FROM mandates m
       JOIN signed_documents s ON s.mandate_id = m.id AND s.copy_content IS NOT NULL
       JOIN documents d ON d.id = s.document_id
       LEFT JOIN mandate_register r ON r.mandate_id = m.id AND r.kind = 'inscription'
       WHERE m.id = ? AND m.network_id = ?`,
      [mandateId, networkId],
    );
    if (!row || row.number === null || row.seq === null || row.property_id !== propertyId || !personIds.includes(row.person_id)) return null;
    if (await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [mandateId])) return null;
    if (await this.db.first(`SELECT seq FROM mandate_register WHERE network_id = ? AND kind = 'annulation' AND cancels_seq = ?`, [networkId, Number(row.seq)])) return null;
    // Un mandat échu ne se prolonge pas par un avenant : il faudrait un nouveau mandat [R42].
    if (await mandateExpired(this.db, mandateId, this.now())) return null;
    let facts: DocumentFacts | null = null;
    try {
      facts = row.facts ? (JSON.parse(row.facts) as DocumentFacts) : null;
    } catch {
      facts = null;
    }
    return { id: row.id, number: row.number, facts };
  }

  /** Un document : celui qui voit la fiche en entier (son agent, la direction, la conformité) [R16]. */
  async read(viewer: Viewer, documentId: string): Promise<{ ok: true; document: GeneratedDocument } | Refusal> {
    const row = await this.db.first<{
      id: string;
      network_id: string;
      kind: DocumentKind;
      mode: 'essai' | 'reel';
      status: 'complet' | 'incomplet';
      missing: string;
      template_id: string;
      template_version: number;
      template_hash: string;
      person_id: string;
      content: string;
      content_hash: string;
      created_at: string;
    }>('SELECT * FROM documents WHERE id = ?', [documentId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, 'document', 'unknown', `document:${documentId}`);
    const read = await this.acces.readFiche(viewer, row.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    // Le texte nomme chaque mandant et chaque représentant : qui le lit voit chacune de leurs fiches en entier (AU001, AU059) [R16].
    for (const person_id of (await documentPersons(this.db, documentId, row.person_id)).slice(1)) {
      const co = await this.acces.readFiche(viewer, person_id);
      if (!co.ok) return co;
      if (co.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    }
    return {
      ok: true,
      document: {
        id: row.id,
        kind: row.kind,
        mode: row.mode,
        status: row.status,
        missing: JSON.parse(row.missing) as string[],
        templateId: row.template_id,
        templateVersion: Number(row.template_version),
        templateHash: row.template_hash,
        content: row.content,
        contentHash: row.content_hash,
        createdAt: row.created_at,
      },
    };
  }
}

/** Les saisies de l'agent, vérifiées : montant entier en euros, charge, durée en mois ; null si l'une est mal formée. */
/**
 * L'objet de l'avenant, écrit par le code depuis les saisies : prix, durée, honoraires, leur charge, type du mandat, et
 * la date d'effet (AU057) ; null si rien ne change (une date d'effet seule ne change rien).
 */
function amendmentObject(inputs: Record<string, string | null>): string | null {
  const parts = [
    inputs['avenant.prix'] ? `prix de vente porté à ${inputs['avenant.prix']}` : null,
    inputs['avenant.duree_mois'] ? `durée du mandat portée à ${inputs['avenant.duree_mois']}` : null,
    inputs['avenant.honoraires'] ? `honoraires portés à ${inputs['avenant.honoraires']}` : null,
    inputs['avenant.honoraires_charge'] ? `honoraires désormais ${inputs['avenant.honoraires_charge']}` : null,
    inputs['avenant.type'] ? `mandat transformé en ${inputs['avenant.type']}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return `${parts.join(' ; ')}${inputs['avenant.date_effet'] ? `, à compter du ${inputs['avenant.date_effet']}` : ''}`;
}

function readInputs(raw: Record<string, unknown>): Record<string, string | null> | null {
  const allowed = new Set<string>(['honoraires.montant', 'honoraires.charge', 'mandat.duree_mois', ...AMENDMENT_INPUTS]);
  if (Object.keys(raw).some((k) => !allowed.has(k))) return null;
  const out: Record<string, string | null> = Object.fromEntries([...allowed].map((k) => [k, null]));
  const newFee = raw['avenant.honoraires'];
  if (newFee !== undefined && newFee !== null) {
    if (typeof newFee !== 'number' || !Number.isInteger(newFee) || newFee < 0 || newFee > 10_000_000) return null;
    out['avenant.honoraires'] = `${number.format(newFee)} €`;
  }
  const newCharge = raw['avenant.honoraires_charge'];
  if (newCharge !== undefined && newCharge !== null) {
    if (newCharge !== 'vendeur' && newCharge !== 'acquereur') return null;
    out['avenant.honoraires_charge'] = newCharge === 'vendeur' ? 'à la charge du vendeur' : 'à la charge de l’acquéreur';
  }
  const newType = raw['avenant.type'];
  if (newType !== undefined && newType !== null) {
    if (newType !== 'simple' && newType !== 'exclusif') return null;
    out['avenant.type'] = newType === 'exclusif' ? 'mandat de vente exclusif' : 'mandat de vente simple';
  }
  const effect = raw['avenant.date_effet'];
  if (effect !== undefined && effect !== null) {
    if (typeof effect !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effect)) return null;
    const d = new Date(`${effect}T12:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== effect) return null;
    out['avenant.date_effet'] = `${effect.slice(8, 10)}/${effect.slice(5, 7)}/${effect.slice(0, 4)}`;
  }
  const price = raw['avenant.prix'];
  if (price !== undefined && price !== null) {
    if (typeof price !== 'number' || !Number.isInteger(price) || price < 1 || price > 1_000_000_000) return null;
    out['avenant.prix'] = `${number.format(price)} €`;
  }
  const newMonths = raw['avenant.duree_mois'];
  if (newMonths !== undefined && newMonths !== null) {
    if (typeof newMonths !== 'number' || !Number.isInteger(newMonths) || newMonths < 1 || newMonths > 120) return null;
    out['avenant.duree_mois'] = `${newMonths} mois`;
  }
  const amount = raw['honoraires.montant'];
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 10_000_000) return null;
    out['honoraires.montant'] = `${number.format(amount)} €`;
  }
  const charge = raw['honoraires.charge'];
  if (charge !== undefined && charge !== null) {
    if (charge !== 'vendeur' && charge !== 'acquereur') return null;
    out['honoraires.charge'] = charge === 'vendeur' ? 'à la charge du vendeur' : 'à la charge de l’acquéreur';
  }
  const months = raw['mandat.duree_mois'];
  if (months !== undefined && months !== null) {
    if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > 120) return null;
    out['mandat.duree_mois'] = `${months} mois`;
  }
  return out;
}

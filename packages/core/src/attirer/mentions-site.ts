/**
 * Les mentions légales et les données personnelles du site (RS05) [R221, R10, R16, R17].
 *
 * Rien n'est écrit d'avance : chaque mention vient des réglages du réseau, ou se dit manquante, sur la page comme à
 * l'écran. Tant qu'une mention manque, ou qu'une preuve du tableau de mise en service n'est pas valide (AU088, R675), le
 * site reste en essai : ni indexé, ni signalé aux moteurs. Le numéro de carte et son
 * titulaire viennent des réglages qui existent déjà, sans seconde saisie.
 *
 * Ces textes attendent la relecture de l'avocat, et leur contenu réel la société (H09).
 */
import type { Viewer } from '../acces/droits.ts';
import { LAUNCH_PREREQUISITES, MiseEnService } from '../conformite/mise-en-service.ts';
import { REGISTRE_TRAITEMENTS } from '../conformite/registre-traitements.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Les mentions réglées à l'écran, avec leur intitulé public. */
export const SITE_MENTION_FIELDS = {
  editeur_nom: 'Dénomination de la société',
  editeur_forme: 'Forme juridique et capital',
  editeur_siege: 'Siège social',
  editeur_rcs: 'Immatriculation au registre du commerce',
  editeur_tva: 'Numéro de TVA intracommunautaire',
  editeur_contact: 'Téléphone et adresse mail de contact',
  directeur_publication: 'Directeur de la publication',
  carte_chambre: 'Chambre qui a délivré la carte professionnelle',
  garant: 'Garant financier, son adresse et le montant garanti',
  assureur: 'Assureur de responsabilité civile professionnelle',
  mediateur: 'Médiateur de la consommation et son site',
  hebergeur_nom: 'Hébergeur du site',
  hebergeur_adresse: 'Adresse de l’hébergeur',
  hebergeur_contact: 'Téléphone de l’hébergeur',
  contact_donnees: 'Contact pour les données personnelles',
} as const;
export type SiteMentionField = keyof typeof SITE_MENTION_FIELDS;
const MAX_VALUE = 300;

export interface SiteMentions {
  values: Partial<Record<SiteMentionField, string>>;
  cardNumber: string | null;
  cardHolder: string | null;
  /** Les intitulés de ce qui manque. */
  missing: string[];
  /**
   * Les preuves du tableau de mise en service qui ne sont pas valides ce jour (AU088) [R675] : leurs intitulés. Le site
   * ne passe en réel qu'avec `missing` et `launchClosedBy` vides.
   */
  launchClosedBy: string[];
}

export type SiteMentionsResult = { ok: true } | { ok: false; rule: 'R16' | null; code: string };

const isField = (k: string): k is SiteMentionField => Object.hasOwn(SITE_MENTION_FIELDS, k);

export class MentionsSite {
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

  async read(networkId: string): Promise<SiteMentions> {
    const rows = await this.db.all<{ field: string; value: string }>('SELECT field, value FROM site_legal_mentions WHERE network_id = ? ORDER BY set_at, rowid', [networkId]);
    const values: SiteMentions['values'] = {};
    for (const r of rows) {
      if (!isField(r.field)) continue;
      if (r.value === '') delete values[r.field];
      else values[r.field] = r.value;
    }
    const card = await this.db.first<{ card_number: string }>('SELECT card_number FROM listing_settings WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    const holder = await this.db.first<{ holder_name: string }>('SELECT holder_name FROM card_holders WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    const cardNumber = card && card.card_number.trim() !== '' ? card.card_number.trim() : null;
    const cardHolder = holder?.holder_name ?? null;
    const missing: string[] = (Object.keys(SITE_MENTION_FIELDS) as SiteMentionField[]).filter((f) => !values[f]).map((f) => SITE_MENTION_FIELDS[f]);
    if (!cardNumber) missing.push(CARD_LABEL);
    if (!cardHolder) missing.push(HOLDER_LABEL);
    const gate = await new MiseEnService(this.db, this.journal, { now: this.now }).gate(networkId, 'site_reel');
    return { values, cardNumber, cardHolder, missing, launchClosedBy: gate.closedBy.map((p) => LAUNCH_PREREQUISITES[p]) };
  }

  /** La direction règle une ou plusieurs mentions ; un texte vide retire la mention. Chaque réglage s'ajoute [R17]. */
  async set(viewer: Viewer, input: unknown): Promise<SiteMentionsResult> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'site_mentions', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length === 0) return { ok: false, rule: null, code: 'mention_invalide' };
    const clean: [SiteMentionField, string][] = [];
    for (const [field, value] of Object.entries(input)) {
      if (!isField(field) || typeof value !== 'string') return { ok: false, rule: null, code: 'mention_invalide' };
      const text = value.trim();
      if (text.length > MAX_VALUE || /[<>]/.test(text)) return { ok: false, rule: null, code: 'mention_invalide' };
      clean.push([field, text]);
    }
    const at = this.now().toISOString();
    for (const [field, text] of clean) {
      await this.db.run('INSERT INTO site_legal_mentions (id, network_id, field, value, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), viewer.networkId, field, text, `direction:${viewer.userId}`, at]);
    }
    await appendEvent(this.journal, { type: 'attirer.site_mentions', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R221', fields: clean.map(([f]) => f) } }, this.now);
    return { ok: true };
  }
}

const CARD_LABEL = 'Numéro de la carte professionnelle';
const HOLDER_LABEL = 'Titulaire de la carte professionnelle';
export const LEGAL_PATHS = ['/mentions-legales', '/donnees-personnelles'] as const;

/** Les deux pages légales, liées depuis chaque page du site : dans le corps de la page, ou à sa fin si elle n'en a pas. */
export function withLegalLinks(html: string): string {
  const links = '<nav class="doux" aria-label="Informations légales"><p><a href="/mentions-legales">Mentions légales</a> · <a href="/donnees-personnelles">Données personnelles</a></p></nav>';
  const at = html.lastIndexOf('</main>');
  const end = at >= 0 ? at : html.lastIndexOf('</body>');
  return end >= 0 ? `${html.slice(0, end)}${links}${html.slice(end)}` : html;
}

const CSS = `${DESIGN_CSS}.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}main{max-width:46rem;margin:0 auto;padding:var(--e-5) var(--e-4) var(--e-8)}.manque{font-weight:700;color:var(--danger)}.alerte{border-left:.25rem solid var(--danger);padding-left:var(--e-3)}dt{font-weight:600;margin-top:var(--e-3)}dd{margin:0}`;

function shell(title: string, body: string): string {
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p><a href="/">Accueil</a></header><div class="frise" aria-hidden="true"></div><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
  );
}

const line = (label: string, value: string | null | undefined): string => `<dt>${escapeHtml(label)}</dt><dd>${value ? escapeHtml(value) : '<span class="manque">Mention manquante</span>'}</dd>`;
const field = (m: SiteMentions, f: SiteMentionField): string => line(SITE_MENTION_FIELDS[f], m.values[f]);
/** Le site peut-il passer en réel : aucune mention ne manque et chaque preuve de mise en service est valide [R221, R675]. */
export const siteReady = (m: SiteMentions): boolean => m.missing.length === 0 && m.launchClosedBy.length === 0;

const alert = (m: SiteMentions): string => {
  if (m.missing.length > 0) return `<p class="alerte" role="status">Cette page n’est pas complète : ${m.missing.length === 1 ? 'une mention manque' : `${m.missing.length} mentions manquent`}. Le site reste en essai tant que c’est le cas.</p>`;
  // Les preuves elles-mêmes restent à l'écran de la direction : la page dit seulement que le site n'est pas ouvert.
  if (m.launchClosedBy.length > 0) return '<p class="alerte" role="status">Ce site n’est pas encore ouvert : sa mise en service n’est pas terminée. Il reste en essai tant que c’est le cas.</p>';
  return '';
};

export function renderLegalNotice(m: SiteMentions): string {
  return shell(
    'Mentions légales',
    alert(m) +
      `<h2>Éditeur du site</h2><dl>${(['editeur_nom', 'editeur_forme', 'editeur_siege', 'editeur_rcs', 'editeur_tva', 'editeur_contact', 'directeur_publication'] as const).map((f) => field(m, f)).join('')}</dl>` +
      `<h2>Activité d’agent immobilier</h2><dl>${line(CARD_LABEL, m.cardNumber)}${line(HOLDER_LABEL, m.cardHolder)}${(['carte_chambre', 'garant', 'assureur', 'mediateur'] as const).map((f) => field(m, f)).join('')}</dl>` +
      `<h2>Hébergeur</h2><dl>${(['hebergeur_nom', 'hebergeur_adresse', 'hebergeur_contact'] as const).map((f) => field(m, f)).join('')}</dl>`,
  );
}

/** Les traitements d'une personne qui passe par le site : leur finalité et leur durée viennent du registre, jamais d'ici [R10]. */
export const SITE_TREATMENTS = ['relation-clients', 'messages', 'assistant-site', 'origine_contacts', 'recrutement', 'espaces_clients'] as const;

const treatments = (): string =>
  SITE_TREATMENTS.flatMap((id) => {
    const t = REGISTRE_TRAITEMENTS.find((x) => x.id === id);
    return t ? [`<dt>${escapeHtml(t.finalite)}</dt><dd>Durée : ${escapeHtml(t.duree)}</dd><dd>Prestataires : ${escapeHtml(t.sousTraitants.join(', ') || 'aucun')}</dd>`] : [];
  }).join('');

export function renderPrivacyPage(m: SiteMentions): string {
  return shell(
    'Données personnelles',
    alert(m) +
      `<h2>Qui en est responsable</h2><dl>${line('Responsable du traitement', m.values.editeur_nom)}${field(m, 'contact_donnees')}</dl>` +
      `<h2>Sur ce site</h2><p>Les pages publiques ne déposent aucun cookie et ne contiennent aucun traceur.</p>` +
      `<p>L’estimation en ligne et le simulateur de prêt ne gardent rien de ce que vous y indiquez.</p>` +
      `<p>L’espace d’un client, une fois ouvert par son lien personnel, pose un cookie de séance.</p>` +
      `<h2>Ce que nous gardons quand vous nous contactez</h2><p>Si vous nous écrivez, posez votre candidature ou ouvrez votre espace, voici pourquoi vos données servent, combien de temps elles sont gardées et qui nous aide à les traiter.</p><dl>${treatments()}</dl>` +
      `<h2>Vos droits</h2><p>Vous pouvez demander l’accès à vos données, leur rectification, leur effacement, leur limitation ou leur portabilité, et vous opposer à leur traitement, en écrivant au contact ci-dessus. Vous pouvez aussi saisir la CNIL.</p>`,
  );
}

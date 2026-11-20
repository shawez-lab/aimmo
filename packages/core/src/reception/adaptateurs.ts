/**
 * Adaptateurs de normalisation : une notification d'un canal devient zéro, un ou plusieurs messages au format commun.
 * Ils ne lisent que ce que le canal donne. Ce qu'ils ne comprennent pas devient « illisible », jamais perdu.
 * La vérification de signature des notifications de Meta est faite à leur arrivée (packages/api/src/meta.ts, C07).
 */
import { normalizeEmail, normalizeInstagram, normalizePhone } from '../fiche/normalize.ts';
import type {
  AdaptContext,
  AdaptResult,
  InboundChannel,
  InboundMessage,
  SenderIdentifier,
  UnreadableInbound,
} from './entrant.ts';

export const INBOUND_SOURCES = ['instagram', 'facebook', 'whatsapp', 'email', 'site_form', 'site_chat'] as const;
export type InboundSource = (typeof INBOUND_SOURCES)[number];

const SOURCE_CHANNEL: Record<InboundSource, InboundChannel> = {
  instagram: 'instagram',
  facebook: 'facebook',
  whatsapp: 'whatsapp',
  email: 'email',
  site_form: 'site',
  site_chat: 'site',
};

/** Ramène une notification brute au format commun, selon sa source. */
export function adaptInbound(source: InboundSource, raw: unknown, ctx: AdaptContext): AdaptResult {
  const channel = SOURCE_CHANNEL[source];
  const result = empty();
  try {
    switch (source) {
      case 'instagram':
        adaptMeta('instagram', raw, ctx, result);
        break;
      case 'facebook':
        adaptMeta('facebook', raw, ctx, result);
        break;
      case 'whatsapp':
        adaptWhatsApp(raw, ctx, result);
        break;
      case 'email':
        push(result, adaptEmail(raw, ctx), channel, raw);
        break;
      case 'site_form':
        push(result, adaptSiteForm(raw, ctx), channel, raw);
        break;
      case 'site_chat':
        push(result, adaptSiteChat(raw, ctx), channel, raw);
        break;
    }
  } catch (error) {
    // Une notification qui fait échouer la lecture est gardée entière, avec ce qui a déjà été lu.
    result.unreadable.push(unreadable(channel, raw, `lecture impossible (${errorName(error)})`));
  }
  return result;
}

// ---------------------------------------------------------------- outils

type Json = Record<string, unknown>;

class Unreadable extends Error {}

function empty(): AdaptResult {
  return { messages: [], unreadable: [], ignored: 0 };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown, what: string): Json {
  if (!isObject(value)) throw new Unreadable(`${what} manquant`);
  return value;
}

function optObj(value: unknown): Json | null {
  return isObject(value) ? value : null;
}

/**
 * Liste d'éléments d'une notification. Absente : vide. Présente mais d'une autre forme : gardée entière comme
 * illisible, pour que rien ne se perde.
 */
function items(value: unknown, channel: InboundChannel, result: AdaptResult, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  result.unreadable.push(unreadable(channel, value, `liste « ${what} » illisible`));
  return [];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.trim() === '') throw new Unreadable(`${what} manquant`);
  return value.trim();
}

function optStr(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Texte du client, gardé tel quel, sans espaces en bord. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Date en millisecondes, en secondes ou en texte ISO ; l'heure de réception sinon. */
function date(value: unknown, ctx: AdaptContext): Date {
  let parsed: Date | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) parsed = new Date(value < 1e12 ? value * 1000 : value);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    parsed = new Date(n < 1e12 ? n * 1000 : n);
  } else if (typeof value === 'string') parsed = new Date(value);
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : ctx.now;
}

function serialize(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

function unreadable(channel: InboundChannel, raw: unknown, reason: string): UnreadableInbound {
  return { channel, reason, raw: serialize(raw) };
}

function errorName(error: unknown): string {
  return error instanceof Unreadable ? error.message : 'format inattendu';
}

/** Lit un élément ; s'il est illisible, il est gardé à part et la lecture continue avec les suivants. */
function each(result: AdaptResult, channel: InboundChannel, item: unknown, read: () => InboundMessage | 'ignored') {
  try {
    const message = read();
    if (message === 'ignored') result.ignored += 1;
    else result.messages.push(message);
  } catch (error) {
    result.unreadable.push(unreadable(channel, item, errorName(error)));
  }
}

function push(result: AdaptResult, message: InboundMessage | null | 'ignored', channel: InboundChannel, raw: unknown) {
  if (message === 'ignored') result.ignored += 1;
  else if (message === null) result.unreadable.push(unreadable(channel, raw, 'message vide'));
  else result.messages.push(message);
}

function ids(...values: (SenderIdentifier | null)[]): SenderIdentifier[] {
  const out: SenderIdentifier[] = [];
  for (const v of values) if (v && !out.some((o) => o.kind === v.kind && o.value === v.value)) out.push(v);
  return out;
}

function emailId(raw: unknown): SenderIdentifier | null {
  const value = typeof raw === 'string' ? normalizeEmail(raw) : null;
  return value ? { kind: 'email', value } : null;
}

function phoneId(raw: unknown, kind: 'phone' | 'whatsapp' = 'phone'): SenderIdentifier | null {
  const value = typeof raw === 'string' || typeof raw === 'number' ? normalizePhone(String(raw)) : null;
  return value ? { kind, value } : null;
}

// ---------------------------------------------------------------- Meta : Instagram et Facebook

function adaptMeta(channel: 'instagram' | 'facebook', raw: unknown, ctx: AdaptContext, result: AdaptResult) {
  const body = obj(raw, 'notification');
  const entries = body.entry;
  if (!Array.isArray(entries)) throw new Unreadable('liste « entry » manquante');
  const own = new Set(ctx.ownIds ?? []);
  for (const entryRaw of entries) {
    const entry = optObj(entryRaw);
    if (!entry) {
      result.unreadable.push(unreadable(channel, entryRaw, 'élément « entry » illisible'));
      continue;
    }
    const entryTime = entry.time;
    if (!['messaging', 'standby', 'changes'].some((key) => key in entry)) {
      result.unreadable.push(unreadable(channel, entryRaw, 'élément « entry » sans contenu connu'));
      continue;
    }
    // `standby` : messages reçus pendant qu'une autre application, comme ManyChat, a la main sur la conversation.
    for (const key of ['messaging', 'standby']) {
      for (const item of items(entry[key], channel, result, key)) {
        each(result, channel, item, () => metaDirect(channel, obj(item, 'message'), own, ctx));
      }
    }
    for (const item of items(entry.changes, channel, result, 'changes')) {
      each(result, channel, item, () => metaChange(channel, obj(item, 'changement'), own, entryTime, ctx));
    }
  }
}

/** Accusés de lecture, de remise, réactions, modifications et provenance publicitaire : pas des messages reçus. */
const META_NOT_MESSAGES = ['read', 'delivery', 'reaction', 'message_edit', 'referral', 'optin'];

function metaDirect(channel: 'instagram' | 'facebook', item: Json, own: Set<string>, ctx: AdaptContext) {
  const senderId = str(obj(item.sender, 'expéditeur').id, 'expéditeur');
  const postback = optObj(item.postback);
  // Bouton ou question d'accueil touchés par le client : c'est un message, dont le texte est le titre du bouton.
  if (postback && !own.has(senderId)) {
    return {
      channel,
      kind: 'direct',
      externalId: str(postback.mid, 'identifiant du message'),
      conversationRef: senderId,
      sender: { channelId: senderId, name: null, identifiers: [] },
      subject: null,
      text: str(postback.title, 'titre du bouton'),
      receivedAt: date(item.timestamp, ctx),
      postRef: null,
      propertyRef: null,
      portal: null,
      hasAttachment: false,
    } satisfies InboundMessage;
  }
  const message = optObj(item.message);
  if (!message) {
    // Seuls les événements connus pour ne pas être des messages sont écartés ; tout autre est gardé comme illisible.
    if (META_NOT_MESSAGES.some((key) => key in item) || own.has(senderId)) return 'ignored';
    throw new Unreadable('événement Meta inconnu');
  }
  // Nos propres messages reviennent en écho : ils ne sont pas des messages reçus.
  if (message.is_echo === true || own.has(senderId)) return 'ignored';
  const attachments = list(message.attachments);
  const body = text(message.text);
  if (body === '' && attachments.length === 0) throw new Unreadable('message sans texte ni pièce jointe');
  return {
    channel,
    kind: 'direct',
    externalId: str(message.mid, 'identifiant du message'),
    conversationRef: senderId,
    sender: { channelId: senderId, name: null, identifiers: [] },
    subject: null,
    text: body,
    receivedAt: date(item.timestamp, ctx),
    postRef: null,
    propertyRef: null,
    portal: null,
    hasAttachment: attachments.length > 0,
  } satisfies InboundMessage;
}

const FACEBOOK_NOT_MESSAGES = ['like', 'reaction', 'share'];
const FACEBOOK_COMMENT_NOT_NEW = ['edited', 'edit', 'remove', 'hide', 'unhide'];

function metaChange(
  channel: 'instagram' | 'facebook',
  item: Json,
  own: Set<string>,
  entryTime: unknown,
  ctx: AdaptContext,
): InboundMessage | 'ignored' {
  const value = obj(item.value, 'contenu du changement');
  if (channel === 'instagram') {
    // Seuls les commentaires sont attendus ; tout autre changement est gardé comme illisible.
    if (item.field !== 'comments' && item.field !== 'live_comments') throw new Unreadable('changement Instagram inconnu');
    const from = obj(value.from, 'auteur du commentaire');
    const fromId = str(from.id, 'auteur du commentaire');
    if (own.has(fromId)) return 'ignored';
    const username = typeof from.username === 'string' ? normalizeInstagram(from.username) : null;
    const commentId = str(value.id, 'identifiant du commentaire');
    const body = text(value.text);
    if (body === '') throw new Unreadable('commentaire sans texte');
    return {
      channel,
      kind: 'comment',
      externalId: commentId,
      conversationRef: commentId,
      sender: {
        channelId: fromId,
        name: optStr(from.username),
        identifiers: ids(username ? { kind: 'instagram', value: username } : null),
      },
      subject: null,
      text: body,
      receivedAt: date(value.timestamp ?? entryTime, ctx),
      postRef: str(obj(value.media, 'publication commentée').id, 'publication commentée'),
      propertyRef: null,
      portal: null,
      hasAttachment: false,
    };
  }
  // Facebook : un commentaire ajouté est un message ; les mentions j'aime, partages, modifications et suppressions
  // connus sont écartés ; tout le reste, y compris un commentaire abîmé ou une publication d'un visiteur, est gardé.
  if (item.field !== 'feed') throw new Unreadable('changement Facebook inconnu');
  const fromRaw = optObj(value.from);
  const fromOwn = fromRaw !== null && own.has(String(fromRaw.id));
  if (FACEBOOK_NOT_MESSAGES.includes(String(value.item))) return 'ignored';
  if (value.item === 'comment' && FACEBOOK_COMMENT_NOT_NEW.includes(String(value.verb))) return 'ignored';
  if (fromOwn) return 'ignored';
  if (value.item !== 'comment' || value.verb !== 'add') throw new Unreadable('événement Facebook non reconnu');
  const from = obj(value.from, 'auteur du commentaire');
  const fromId = str(from.id, 'auteur du commentaire');
  const commentId = str(value.comment_id, 'identifiant du commentaire');
  const body = text(value.message);
  const hasAttachment = optStr(value.photo) !== null || optStr(value.video) !== null;
  if (body === '' && !hasAttachment) throw new Unreadable('commentaire sans texte');
  return {
    channel,
    kind: 'comment',
    externalId: commentId,
    conversationRef: commentId,
    sender: { channelId: fromId, name: optStr(from.name), identifiers: [] },
    subject: null,
    text: body,
    receivedAt: date(value.created_time ?? entryTime, ctx),
    postRef: str(value.post_id, 'publication commentée'),
    propertyRef: null,
    portal: null,
    hasAttachment,
  };
}

// ---------------------------------------------------------------- WhatsApp

const WHATSAPP_MEDIA = ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts'];

function adaptWhatsApp(raw: unknown, ctx: AdaptContext, result: AdaptResult) {
  const body = obj(raw, 'notification');
  const entries = body.entry;
  if (!Array.isArray(entries)) throw new Unreadable('liste « entry » manquante');
  for (const entryRaw of entries) {
    const entry = optObj(entryRaw);
    if (!entry) {
      result.unreadable.push(unreadable('whatsapp', entryRaw, 'élément « entry » illisible'));
      continue;
    }
    if (!Array.isArray(entry.changes)) {
      result.unreadable.push(unreadable('whatsapp', entryRaw, 'liste « changes » illisible'));
      continue;
    }
    for (const changeRaw of entry.changes) {
      const change = optObj(changeRaw);
      const value = optObj(change?.value);
      if (!change || !value) {
        result.unreadable.push(unreadable('whatsapp', changeRaw, 'changement illisible'));
        continue;
      }
      if (change.field !== 'messages') {
        result.ignored += 1;
        continue;
      }
      // Statuts de remise et de lecture de nos propres messages : pas des messages reçus.
      result.ignored += items(value.statuses, 'whatsapp', result, 'statuses').length;
      const names = new Map<string, string>();
      for (const c of list(value.contacts)) {
        const contact = optObj(c);
        const waId = optStr(contact?.wa_id);
        const name = optStr(optObj(contact?.profile)?.name);
        if (waId && name) names.set(waId, name);
      }
      for (const item of items(value.messages, 'whatsapp', result, 'messages')) {
        each(result, 'whatsapp', item, () => whatsAppMessage(obj(item, 'message'), names, ctx));
      }
    }
  }
}

function whatsAppMessage(item: Json, names: Map<string, string>, ctx: AdaptContext): InboundMessage | 'ignored' {
  const from = str(item.from, 'expéditeur');
  const type = optStr(item.type);
  if (type === 'reaction') return 'ignored';
  let body = '';
  let hasAttachment = false;
  if (type === 'text') body = text(optObj(item.text)?.body);
  else if (type === 'button') body = text(optObj(item.button)?.text);
  else if (type === 'interactive') {
    const interactive = optObj(item.interactive);
    body = text(optObj(interactive?.button_reply)?.title ?? optObj(interactive?.list_reply)?.title);
  } else if (type !== null && WHATSAPP_MEDIA.includes(type)) {
    hasAttachment = true;
    body = text(optObj(item[type])?.caption);
  }
  if (body === '' && !hasAttachment) throw new Unreadable(`message WhatsApp de type ${type && /^[a-z_]{1,20}$/.test(type) ? type : 'inconnu'} illisible`);
  const phone = phoneId(from.startsWith('+') ? from : `+${from}`, 'whatsapp');
  return {
    channel: 'whatsapp',
    kind: 'direct',
    externalId: str(item.id, 'identifiant du message'),
    conversationRef: from,
    sender: { channelId: from, name: names.get(from) ?? null, identifiers: ids(phone) },
    subject: null,
    text: body,
    receivedAt: date(item.timestamp, ctx),
    postRef: null,
    propertyRef: null,
    portal: null,
    hasAttachment,
  };
}

// ---------------------------------------------------------------- Mail

/** Portails dont les demandes arrivent par mail, reconnus au domaine de l'expéditeur. */
export const PORTAL_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  'seloger.com': 'seloger',
  'leboncoin.fr': 'leboncoin',
  'bienici.com': 'bienici',
  'logic-immo.com': 'logic-immo',
  'pap.fr': 'pap',
  'avendrealouer.fr': 'avendrealouer',
  'figaroimmo.fr': 'figaroimmo',
  'meilleursagents.com': 'meilleursagents',
});

/** Adresse dans « Prénom Nom <adresse> » ou seule. */
function parseAddress(raw: unknown): { name: string | null; address: string | null } {
  if (typeof raw !== 'string') return { name: null, address: null };
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || null, address: normalizeEmail(match[2] ?? '') };
  return { name: null, address: normalizeEmail(raw) };
}

function portalOf(address: string | null): string | null {
  if (!address) return null;
  const domain = address.split('@')[1] ?? '';
  for (const [portalDomain, portal] of Object.entries(PORTAL_DOMAINS)) {
    if (domain === portalDomain || domain.endsWith(`.${portalDomain}`)) return portal;
  }
  return null;
}

function firstMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.match(/<[^>]+>/)?.[0] ?? optStr(value);
}

/**
 * Ce qu'un mail de portail écrit dans son corps (AU032) : beaucoup de portails n'ont pas de « répondre à » vers le
 * client, ou une adresse relais du portail, et donnent les coordonnées en lignes « Libellé : valeur ». Seules ces lignes
 * sont lues, jamais un texte libre : une adresse citée par le client dans son message n'est pas la sienne.
 */
export interface PortalBodyFields {
  email: string | null;
  phone: string | null;
  name: string | null;
  /** La référence de la demande chez le portail : la même demande relivrée sous un autre identifiant de mail. */
  leadRef: string | null;
}

const FIELD = /^[\s>*•-]*([A-Za-zÀ-ÿ'’°. -]{2,40}?)\s*:\s*(.+?)\s*$/;

export function readPortalBody(text: string): PortalBodyFields {
  const out: PortalBodyFields = { email: null, phone: null, name: null, leadRef: null };
  let first: string | null = null;
  let last: string | null = null;
  for (const line of text.split('\n').slice(0, 200)) {
    const m = FIELD.exec(line);
    if (!m) continue;
    const label = m[1]!.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
    const value = m[2]!.trim();
    if (out.email === null && /^(e-?mail|courriel|mail|adresse (e-?mail|mail|electronique))( du contact)?$/.test(label)) {
      const found = value.match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/i)?.[0];
      if (found) out.email = found;
    } else if (out.phone === null && /^(telephone|tel\.?|portable|mobile|numero de telephone)( du contact)?$/.test(label)) {
      if (/^[+0-9 .()-]{8,25}$/.test(value)) out.phone = value;
    } else if (out.name === null && /^(nom et prenom|prenom et nom|nom complet|nom du contact|contact)$/.test(label)) {
      out.name = value.slice(0, 80);
    } else if (first === null && label === 'prenom') {
      first = value.slice(0, 40);
    } else if (last === null && label === 'nom') {
      last = value.slice(0, 40);
    } else if (out.leadRef === null && /^(reference|ref\.?|n°|numero|identifiant) (de la |du )?(demande|contact|lead|message)$/.test(label)) {
      if (/^[A-Za-z0-9._-]{4,64}$/.test(value)) out.leadRef = value;
    }
  }
  if (out.name === null && (first !== null || last !== null)) out.name = [first, last].filter((v) => v !== null).join(' ');
  return out;
}

function adaptEmail(raw: unknown, ctx: AdaptContext): InboundMessage | null | 'ignored' {
  const mail = obj(raw, 'mail');
  const from = parseAddress(mail.from);
  if (!from.address) throw new Unreadable('expéditeur du mail illisible');
  // Nos propres mails, renvoyés par la boîte de réception, ne sont pas des messages reçus.
  const own = new Set((ctx.ownIds ?? []).map((id) => normalizeEmail(id) ?? id));
  if (own.has(from.address)) return 'ignored';
  const replyTo = parseAddress(mail.replyTo);
  const portal = portalOf(from.address);
  // Un mail de portail vient d'une adresse du portail : le client est dans « répondre à », quand il y est.
  const client = portal ? replyTo : replyTo.address ? replyTo : from;
  const body = text(mail.text);
  const subject = optStr(mail.subject);
  const attachments = typeof mail.attachments === 'number' ? mail.attachments : list(mail.attachments).length;
  if (body === '' && subject === null && attachments === 0) return null;
  const messageId = str(mail.messageId, 'identifiant du mail');
  // Un mail de portail : les coordonnées du client lues aussi dans le corps (AU032) [R669]. Jamais une adresse du portail
  // ni l'une des nôtres ; la référence de la demande fait reconnaître la même demande relivrée sous un autre identifiant.
  const fields = portal ? readPortalBody(body) : null;
  const bodyEmail = fields?.email ? normalizeEmail(fields.email) : null;
  const bodyMail = bodyEmail && !portalOf(bodyEmail) && !own.has(bodyEmail) ? emailId(bodyEmail) : null;
  const bodyPhone = fields?.phone ? phoneId(fields.phone) : null;
  return {
    channel: 'email',
    kind: portal ? 'portal_email' : 'email',
    externalId: portal && fields?.leadRef ? `${portal}:demande:${fields.leadRef}` : messageId,
    conversationRef: firstMessageId(mail.references) ?? firstMessageId(mail.inReplyTo) ?? messageId,
    sender: {
      channelId: null,
      name: client.name ?? (portal ? (fields?.name ?? null) : from.name),
      identifiers: ids(client.address && !portalOf(client.address) && !own.has(client.address) ? { kind: 'email', value: client.address } : null, bodyMail, bodyPhone),
    },
    subject,
    text: body,
    receivedAt: date(mail.date, ctx),
    postRef: null,
    propertyRef: null,
    portal,
    hasAttachment: attachments > 0,
  };
}

// ---------------------------------------------------------------- Site : formulaire « Être rappelé » et assistant

function adaptSiteForm(raw: unknown, ctx: AdaptContext): InboundMessage | null {
  const form = obj(raw, 'formulaire');
  const identifiers = ids(emailId(form.email), phoneId(form.phone));
  const body = text(form.message);
  if (identifiers.length === 0 && body === '') return null;
  return {
    channel: 'site',
    kind: 'form',
    externalId: str(form.submissionId, 'identifiant de l’envoi'),
    conversationRef: null,
    sender: { channelId: null, name: optStr(form.firstName), identifiers },
    subject: null,
    text: body,
    receivedAt: date(form.submittedAt, ctx),
    postRef: null,
    propertyRef: optStr(form.propertyRef) ?? optStr(form.page),
    portal: null,
    hasAttachment: false,
  };
}

function adaptSiteChat(raw: unknown, ctx: AdaptContext): InboundMessage | null {
  const chat = obj(raw, 'message de l’assistant');
  const sessionId = str(chat.sessionId, 'session');
  // Le visiteur, d'une session à l'autre : une référence stable donnée par l'API (empreinte, jamais en clair), pour
  // qu'ouvrir une nouvelle conversation ne fasse pas oublier un arrêt ou une exclusion [R02, R04]. Sinon, la session.
  const visitorRef = optStr(chat.visitorRef) ?? sessionId;
  const body = text(chat.text);
  if (body === '') return null;
  return {
    channel: 'site',
    kind: 'site_chat',
    externalId: `${sessionId}/${str(chat.messageId, 'identifiant du message')}`,
    conversationRef: sessionId,
    sender: { channelId: visitorRef, name: null, identifiers: [] },
    subject: null,
    text: body,
    receivedAt: date(chat.sentAt, ctx),
    postRef: null,
    propertyRef: optStr(chat.propertyRef) ?? optStr(chat.page),
    portal: null,
    hasAttachment: false,
  };
}

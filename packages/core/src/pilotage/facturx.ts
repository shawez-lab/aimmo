/**
 * La facture électronique au format Factur-X, profil EN 16931 (HX04) [R71, R254, R255].
 *
 * Le code écrit le XML CII (Cross Industry Invoice, D16B) qu'attend la plateforme agréée, à partir de la facture figée
 * de K02 et de l'identité réelle de l'émetteur et du client. Rien n'est inventé : sans SIREN, sans adresse, sans
 * conditions de paiement ou sans régime de TVA dit pour l'émetteur, le XML n'est pas écrit et le contrôle dit ce qui
 * manque, avec le numéro de la règle EN 16931 qui l'exige. Le contrôle recompte aussi chaque total au centime
 * (BR-CO-10 à BR-CO-16) : un XML dont les totaux ne retombent pas sur la facture n'existe pas.
 *
 * Décidé, lecture prudente : une seule ligne par facture (la désignation de K02) ; un avoir est un document 381, aux
 * montants positifs, qui renvoie à la facture qu'il corrige (BT-25) ; la date de l'acte est la date de livraison
 * (BT-72) ; la TVA à 0 % n'existe qu'avec une catégorie et un motif d'exonération dits par l'émetteur (par exemple la
 * franchise en base d'un agent), jamais déduite ; le conteneur PDF/A-3 est une autre tâche (HX60).
 */
import type { InvoiceContent } from './factures.ts';

export const FACTURX_PROFILE = 'urn:cen.eu:en16931:2017';

export interface AdressePostale {
  line1: string;
  line2?: string;
  postcode: string;
  city: string;
  /** Code pays ISO 3166-1 alpha-2, par exemple `FR`. */
  country: string;
}

/** Le régime de TVA de l'émetteur, dit par lui ou son expert-comptable, jamais déduit. */
export type RegimeTva = { category: 'S' } | { category: 'E'; exemptionReason: string };

/** L'émetteur : la société du réseau (H09) ou l'agent qui facture son reversement. */
export interface IdentiteEmetteur {
  name: string;
  /** SIREN, 9 chiffres (BT-30, schéma 0002). */
  siren: string;
  /** Numéro de TVA intracommunautaire (BT-31), exigé en TVA normale (BR-S-02) comme en exonération (BR-E-02). */
  vatId?: string;
  address: AdressePostale;
  regime: RegimeTva;
  /** Conditions de paiement, pénalités de retard et indemnité de recouvrement comprises (BT-20, BR-CO-25). */
  paymentTerms: string;
  /** L'émetteur a opté pour le paiement de la TVA d'après les débits : dit par lui, jamais déduit (AU013). */
  vatOnDebits?: boolean;
}

export interface IdentiteClient {
  name: string;
  /** SIREN d'un client professionnel ; absent pour un particulier. */
  siren?: string;
  address: AdressePostale;
}

export interface FacturXInput {
  content: InvoiceContent;
  seller: IdentiteEmetteur | null;
  buyer: IdentiteClient | null;
}

export type ControleFacturX = { ok: true; xml: string } | { ok: false; missing: string[] };

const COUNTRY = /^[A-Z]{2}$/;
const SIREN = /^\d{9}$/;
const VAT_ID = /^[A-Z]{2}[0-9A-Z]{2,13}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Un montant en centimes, en euros à deux décimales, au point, sans signe négatif (montants d'avoir en positif). */
const amount = (cents: number): string => {
  const a = Math.abs(cents);
  return `${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

const rate = (bp: number): string => {
  const whole = Math.floor(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
};

const date102 = (day: string): string => day.replace(/-/g, '');

function addressMissing(prefix: string, a: AdressePostale | undefined, rule: string): string[] {
  if (!a) return [`${prefix}.adresse (${rule})`];
  const out: string[] = [];
  if (!a.line1?.trim()) out.push(`${prefix}.adresse.ligne (${rule})`);
  if (!a.postcode?.trim()) out.push(`${prefix}.adresse.code_postal (${rule})`);
  if (!a.city?.trim()) out.push(`${prefix}.adresse.ville (${rule})`);
  if (!COUNTRY.test(a.country ?? '')) out.push(`${prefix}.adresse.pays (${rule})`);
  return out;
}

/**
 * Ce qui manque pour une facture EN 16931 conforme, avec la règle qui l'exige ; vide quand tout y est. Les totaux sont
 * recomptés : HT + TVA = TTC, TVA = HT × taux au centime, et le signe suit la sorte de la facture.
 */
export function manquesFacturX(input: FacturXInput): string[] {
  const { content: c, seller, buyer } = input;
  const missing: string[] = [];
  if (!c.label?.trim()) missing.push('numero (BR-02)');
  if (!DAY.test(c.issuedOn ?? '')) missing.push('date (BR-03)');
  if (!c.designation?.trim()) missing.push('designation (BR-25)');
  if (!seller) missing.push('emetteur (BR-06)');
  else {
    if (!seller.name.trim()) missing.push('emetteur.nom (BR-06)');
    if (!SIREN.test(seller.siren)) missing.push('emetteur.siren (BT-30)');
    missing.push(...addressMissing('emetteur', seller.address, 'BR-08'));
    if (!seller.paymentTerms.trim()) missing.push('conditions_paiement (BR-CO-25)');
    if (seller.regime.category === 'S') {
      if (c.vatBp <= 0) missing.push('taux_tva (BR-S-05)');
      if (!VAT_ID.test(seller.vatId ?? '')) missing.push('emetteur.tva_intracommunautaire (BR-S-02)');
    } else {
      if (c.vatBp !== 0) missing.push('taux_tva (BR-E-05)');
      if (!seller.regime.exemptionReason.trim()) missing.push('motif_exoneration (BR-E-10)');
      if (!VAT_ID.test(seller.vatId ?? '')) missing.push('emetteur.tva_intracommunautaire (BR-E-02)');
    }
  }
  if (!buyer) missing.push('client (BR-07)');
  else {
    if (!buyer.name.trim()) missing.push('client.nom (BR-07)');
    if (buyer.siren !== undefined && !SIREN.test(buyer.siren)) missing.push('client.siren (BT-47)');
    missing.push(...addressMissing('client', buyer.address, 'BR-10'));
  }
  if (c.kind === 'avoir' && !c.corrects?.trim()) missing.push('facture_corrigee (BT-25)');
  // Les totaux, au centime, et le signe de la sorte : une facture est positive, un avoir négatif.
  const sign = c.kind === 'avoir' ? -1 : 1;
  if (c.htCents * sign < 0 || c.vatCents * sign < 0 || c.ttcCents * sign <= 0) missing.push('signe_des_montants (BR-CO-15)');
  if (c.htCents + c.vatCents !== c.ttcCents) missing.push('total_ttc (BR-CO-15)');
  // K02 tire le HT du TTC : la TVA recalculée sur le HT peut s'écarter d'un centime, ce que BR-CO-17 admet.
  if (Math.abs(Math.round((Math.abs(c.htCents) * c.vatBp) / 10_000) - Math.abs(c.vatCents)) > 1) missing.push('total_tva (BR-CO-17)');
  return missing;
}

function addressXml(a: AdressePostale): string {
  return [
    '<ram:PostalTradeAddress>',
    `<ram:PostcodeCode>${esc(a.postcode.trim())}</ram:PostcodeCode>`,
    `<ram:LineOne>${esc(a.line1.trim())}</ram:LineOne>`,
    ...(a.line2?.trim() ? [`<ram:LineTwo>${esc(a.line2.trim())}</ram:LineTwo>`] : []),
    `<ram:CityName>${esc(a.city.trim())}</ram:CityName>`,
    `<ram:CountryID>${a.country}</ram:CountryID>`,
    '</ram:PostalTradeAddress>',
  ].join('');
}

function taxXml(c: InvoiceContent, regime: RegimeTva, withAmounts: boolean): string {
  return [
    '<ram:ApplicableTradeTax>',
    ...(withAmounts ? [`<ram:CalculatedAmount>${amount(c.vatCents)}</ram:CalculatedAmount>`] : []),
    '<ram:TypeCode>VAT</ram:TypeCode>',
    ...(withAmounts && regime.category === 'E' ? [`<ram:ExemptionReason>${esc(regime.exemptionReason.trim())}</ram:ExemptionReason>`] : []),
    ...(withAmounts ? [`<ram:BasisAmount>${amount(c.htCents)}</ram:BasisAmount>`] : []),
    `<ram:CategoryCode>${regime.category}</ram:CategoryCode>`,
    `<ram:RateApplicablePercent>${rate(c.vatBp)}</ram:RateApplicablePercent>`,
    '</ram:ApplicableTradeTax>',
  ].join('');
}

/**
 * Le XML Factur-X EN 16931 d'une facture figée, ou ce qui manque pour l'écrire. Le XML est déterministe : la même
 * facture et les mêmes identités donnent toujours le même texte, pour que son empreinte prouve ce qui est parti.
 */
export function factureElectronique(input: FacturXInput): ControleFacturX {
  const missing = manquesFacturX(input);
  if (missing.length > 0) return { ok: false, missing };
  const c = input.content;
  const seller = input.seller!;
  const buyer = input.buyer!;
  const typeCode = c.kind === 'avoir' ? '381' : '380';
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
    '<rsm:ExchangedDocumentContext>',
    `<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${FACTURX_PROFILE}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>`,
    '</rsm:ExchangedDocumentContext>',
    '<rsm:ExchangedDocument>',
    `<ram:ID>${esc(c.label)}</ram:ID>`,
    `<ram:TypeCode>${typeCode}</ram:TypeCode>`,
    `<ram:IssueDateTime><udt:DateTimeString format="102">${date102(c.issuedOn)}</udt:DateTimeString></ram:IssueDateTime>`,
    ...c.mentions.map((m) => `<ram:IncludedNote><ram:Content>${esc(m)}</ram:Content></ram:IncludedNote>`),
    '</rsm:ExchangedDocument>',
    '<rsm:SupplyChainTradeTransaction>',
    '<ram:IncludedSupplyChainTradeLineItem>',
    '<ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>',
    `<ram:SpecifiedTradeProduct><ram:Name>${esc(c.designation)}</ram:Name></ram:SpecifiedTradeProduct>`,
    `<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${amount(c.htCents)}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>`,
    '<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>',
    '<ram:SpecifiedLineTradeSettlement>',
    taxXml(c, seller.regime, false),
    `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amount(c.htCents)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`,
    '</ram:SpecifiedLineTradeSettlement>',
    '</ram:IncludedSupplyChainTradeLineItem>',
    '<ram:ApplicableHeaderTradeAgreement>',
    '<ram:SellerTradeParty>',
    `<ram:Name>${esc(seller.name.trim())}</ram:Name>`,
    `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${seller.siren}</ram:ID></ram:SpecifiedLegalOrganization>`,
    addressXml(seller.address),
    ...(seller.vatId ? [`<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(seller.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`] : []),
    '</ram:SellerTradeParty>',
    '<ram:BuyerTradeParty>',
    `<ram:Name>${esc(buyer.name.trim())}</ram:Name>`,
    ...(buyer.siren ? [`<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${buyer.siren}</ram:ID></ram:SpecifiedLegalOrganization>`] : []),
    addressXml(buyer.address),
    '</ram:BuyerTradeParty>',
    '</ram:ApplicableHeaderTradeAgreement>',
    '<ram:ApplicableHeaderTradeDelivery>',
    ...(c.saleDay && DAY.test(c.saleDay)
      ? [`<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${date102(c.saleDay)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>`]
      : []),
    '</ram:ApplicableHeaderTradeDelivery>',
    '<ram:ApplicableHeaderTradeSettlement>',
    '<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>',
    taxXml(c, seller.regime, true),
    `<ram:SpecifiedTradePaymentTerms><ram:Description>${esc(seller.paymentTerms.trim())}</ram:Description></ram:SpecifiedTradePaymentTerms>`,
    '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    `<ram:LineTotalAmount>${amount(c.htCents)}</ram:LineTotalAmount>`,
    `<ram:TaxBasisTotalAmount>${amount(c.htCents)}</ram:TaxBasisTotalAmount>`,
    `<ram:TaxTotalAmount currencyID="EUR">${amount(c.vatCents)}</ram:TaxTotalAmount>`,
    `<ram:GrandTotalAmount>${amount(c.ttcCents)}</ram:GrandTotalAmount>`,
    `<ram:DuePayableAmount>${amount(c.ttcCents)}</ram:DuePayableAmount>`,
    '</ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    ...(c.kind === 'avoir' ? [`<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${esc(c.corrects!)}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>`] : []),
    '</ram:ApplicableHeaderTradeSettlement>',
    '</rsm:SupplyChainTradeTransaction>',
    '</rsm:CrossIndustryInvoice>',
    '',
  ].join('\n');
  return { ok: true, xml };
}

/** Relit dans le XML les totaux d'en-tête, en centimes, pour vérifier qu'ils retombent sur la facture. */
export function totauxFacturX(xml: string): { htCents: number; vatCents: number; ttcCents: number; dueCents: number; typeCode: string; id: string } | null {
  const pick = (tag: string): string | null => new RegExp(`<ram:${tag}(?: [^>]*)?>([^<]*)</ram:${tag}>`).exec(xml.split('<ram:SpecifiedTradeSettlementHeaderMonetarySummation>')[1] ?? '')?.[1] ?? null;
  const cents = (v: string | null): number | null => (v && /^\d+\.\d{2}$/.test(v) ? Number(v.replace('.', '')) : null);
  const ht = cents(pick('TaxBasisTotalAmount'));
  const vat = cents(pick('TaxTotalAmount'));
  const ttc = cents(pick('GrandTotalAmount'));
  const due = cents(pick('DuePayableAmount'));
  const typeCode = /<ram:TypeCode>(38[01])<\/ram:TypeCode>/.exec(xml)?.[1];
  const id = /<rsm:ExchangedDocument>\s*<ram:ID>([^<]*)<\/ram:ID>/.exec(xml)?.[1];
  if (ht === null || vat === null || ttc === null || due === null || !typeCode || !id) return null;
  return { htCents: ht, vatCents: vat, ttcCents: ttc, dueCents: due, typeCode, id };
}

# Export vers les portails

Tâche P07 du module M07. Pendant la preuve à Dijon, les portails sont servis par le logiciel de l'agence : le flux AIMMO est construit en mode essai et ne part vers aucun portail tant que les comptes et accords de flux (H10) ne sont pas là.

## Ce que porte le flux

Le flux est rempli depuis la dernière version publiée de chaque bien (P04). Il porte donc le même prix et les mêmes mentions que la page du bien et les autres canaux [R43, R44]. Un bien vendu ou retiré de la vente sort du flux au passage suivant. Le flux ne porte jamais d'adresse, de nom ni de coordonnée du vendeur [R46]. Une photo d'aménagement virtuel porte la mention à poser sur l'image [R48].

## Format d'essai `aimmo-essai-1`

Un document XML en UTF-8, une annonce par bien, triées par référence. Une même version donne le même flux, au caractère près.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<flux format="aimmo-essai-1">
  <annonce reference="REF-1" version="3" etat="en_vente">
    <prix devise="EUR">210000</prix>
    <titre>…</titre>
    <texte>…</texte>
    <mentions>…</mentions>
    <dpe numero="2321E0123456J" energie_primaire="212" ges="41" classe_energie="D" classe_climat="D" date="2027-01-15"/>
    <medias>
      <media type="photo" ref="biens/<id>/<identifiant>.jpg"/>
      <media type="photo" ref="biens/<id>/<identifiant>.jpg" mention="Aménagement virtuel"/>
      <media type="video" ref="biens/<id>/<identifiant>.mp4"/>
    </medias>
  </annonce>
</flux>
```

- `etat` : `en_vente` ou `sous_offre`.
- `prix` : le prix publié, honoraires inclus quand l'acquéreur les paie, en euros entiers.
- `mentions` : les mentions obligatoires calculées par le code, une par ligne.
- `dpe` (AU064) : le diagnostic tel qu'il est rangé dans la fiche, pour le reprendre sans ressaisie : son numéro d'enregistrement à l'ADEME (`numero`, 13 caractères), l'énergie primaire en kWh/m²/an (`energie_primaire`), les émissions en kg CO₂/m²/an (`ges`), les deux classes et le jour du diagnostic. Seuls les attributs connus sont écrits ; sans numéro ni valeurs, l'élément est absent.

## Portails étrangers : format d'essai `aimmo-essai-international-1` (HX05)

Le même flux, une annonce par bien et par langue traduite et validée par l'agent du bien : anglais toujours, et chaque langue que l'agent déclare parler (ourdou `ur`, hindi `hi`, pendjabi en gurmukhi `pa`, persan `fa`, arabe `ar`, grec `el`). Triées par référence, puis dans cet ordre de langues.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<flux format="aimmo-essai-international-1">
  <annonce reference="REF-1" version="3" etat="en_vente" langue="ar" sens="rtl">
    <prix devise="EUR">210000</prix>
    <titre>… traduit …</titre>
    <texte>… traduit …</texte>
    <mentions langue="fr">… mentions françaises, au caractère près …</mentions>
    <medias>…</medias>
  </annonce>
</flux>
```

- Seuls le titre et le texte sont traduits. Prix, mentions, médias, état et version sont ceux de la version française publiée [R259].
- Une traduction garde les mêmes nombres, écrits pareil, et la même classe énergie ; l'IA ne les voit jamais [R257].
- Une traduction n'entre au flux que validée par l'agent du bien, sur l'annonce française publiée, dans une langue qu'il parle encore [R258].
- `sens` : `rtl` pour l'ourdou, le persan et l'arabe, sinon `ltr`.

## Diffusion accusée par portail (AU004) [R668]

AIMMO publie, modifie et retire lui-même chaque bien sur chaque portail souscrit, sans l'ancien logiciel de l'agence :

- la direction règle chaque portail (HX38) : `POST /v1/annonces-portails` `{ "code", "label", "host", "requiredFields", "minPhotos", "active" }`, liste par `GET` ; l'agent du bien le choisit ou l'écarte : `POST /v1/annonces/<id du bien>/portails` `{ "portal", "chosen" }` ; un retrait temporaire (HX38) compte aussi ;
- à chaque passage de publication (toutes les 15 minutes, ou le passage immédiat de l'agent), chaque portail souscrit reçoit le geste qui lui manque : `publier`, `modifier` (nouvelle version publiée) ou `retirer` (bien sorti de la vente, portail écarté, suspendu ou arrêté) ;
- un geste n'est tenu pour fait que sur l'accusé du portail (son identifiant de dépôt), rangé avec la version, la date et l'identifiant de l'annonce chez le portail ; chaque geste porte une clé (la même pour chaque nouvel essai d'un geste resté sans accusé) et un ordre croissant ; le connecteur applique une clé une fois et ignore un geste d'ordre plus petit qu'un geste déjà appliqué ; un geste sans accusé est tenu pour peut-être appliqué : l'annonce est retirée si elle ne doit plus être en ligne, déposée de nouveau si elle doit l'être ;
- le statut par portail se lit par `GET /v1/annonces/<id du bien>/portails` : `publiee`, `en_attente`, `echec` (avec son code), `retiree`, `non_publiee`, ou `essai` quand le portail n'a pas encore de connecteur réel (rien ne part).

## Ajouter un portail

Un portail réel s'ajoute par un connecteur qui suit l'interface `PortalConnector` (`packages/core/src/annonces/diffusion-portails.ts`, `mode: 'reel'`, `send` rend l'accusé), passé à `annonceRoutes` et `syncAnnonces` par `portals`, avec ses tests, une fois son accord de flux obtenu (H10). Le flux d'essai `PortalFormat` reste pour les portails qui lisent un fichier.

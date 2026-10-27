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

## Ajouter un portail

Un portail réel s'ajoute par un format qui suit l'interface `PortalFormat` (`packages/core/src/annonces/portails.ts`), avec ses tests, une fois son accord de flux obtenu (H10).

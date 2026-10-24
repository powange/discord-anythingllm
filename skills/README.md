# Skills d'agent AnythingLLM pour Sea of Thieves

Skills personnalisées à installer dans AnythingLLM (pas dans le bot). Chacune fait sa recherche et sa
lecture en un seul appel, et tronque son résultat à ~6 000 caractères pour un modèle local.

| Skill | Source | Pour les questions du type |
|---|---|---|
| [`sot-wiki`](sot-wiki) | API MediaWiki de [seaofthieves.wiki.gg](https://seaofthieves.wiki.gg) | personnages, navires du lore, îles, quêtes, créatures, mécaniques |
| [`sot-guides`](sot-guides) | API WordPress de [Rare Thief](https://rarethief.com) (1000+ guides) | solutions d'énigmes, Tall Tales pas à pas, défis Bilge Rats du mois |
| [`sot-news`](sot-news) | Annonces officielles de Rare, via l'API des actualités Steam | quoi de neuf, événements, Twitch Drops, Community Weekend |
| [`sot-status`](sot-status) | API de la [page de statut officielle](https://status.seaofthieves.com) + joueurs Steam | serveurs en panne, maintenance, incidents récents, joueurs en ligne |

Les sources sont en anglais : l'agent cherche en anglais et répond en français.

`sot-status` se présente comme un navigateur, car la page de statut refuse les autres clients.
Elle ne fait qu'un appel par question posée, l'équivalent d'ouvrir la page.

Sources écartées après analyse : le site officiel (actualités générées dans le navigateur), Reddit
(bloque les requêtes automatiques), l'ancien wiki Fandom (remplacé par wiki.gg).

## Installation (AnythingLLM Desktop sous Windows)

Dans PowerShell, sur la machine qui fait tourner AnythingLLM (installe ou met à jour les quatre skills) :

```powershell
$root = "$env:APPDATA\anythingllm-desktop\storage\plugins\agent-skills"
$base = "https://raw.githubusercontent.com/powange/discord-anythingllm/main/skills"
foreach ($skill in "sot-wiki", "sot-guides", "sot-news", "sot-status") {
  New-Item -ItemType Directory -Force "$root\$skill" | Out-Null
  foreach ($f in "plugin.json", "handler.js") {
    Invoke-WebRequest "$base/$skill/$f" -OutFile "$root\$skill\$f" -UseBasicParsing
  }
}
Get-ChildItem $root
```

Puis recharger AnythingLLM (Ctrl+R) et activer les skills dans *Paramètres > Compétences de l'agent*.
Le nom de chaque dossier doit rester identique au `hubId` de son `plugin.json`.

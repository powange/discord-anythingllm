# Skill AnythingLLM : Wiki Sea of Thieves

Skill d'agent personnalisée pour AnythingLLM. En un seul appel, elle cherche dans le wiki
[seaofthieves.wiki.gg](https://seaofthieves.wiki.gg) (API MediaWiki), ouvre la page la plus pertinente
et renvoie son contenu nettoyé : infobox, texte, liste des sections et autres pages pertinentes.
Elle couvre toutes les pages du wiki, y compris les nouvelles, sans rien ajouter.

- `query` : mots-clés ou titre de page, **en anglais** (le wiki est en anglais).
- `section` (optionnel) : lire une section entière (ex. `Lore`) quand le contenu était tronqué.

Le contenu est tronqué à 6 000 caractères pour tenir dans le contexte d'un modèle local.

## Installation (AnythingLLM Desktop sous Windows)

1. Copier le dossier `sot-wiki` (avec `plugin.json` et `handler.js`) dans
   `%APPDATA%\anythingllm-desktop\storage\plugins\agent-skills\`.
   Le nom du dossier doit rester `sot-wiki` : il doit être identique au `hubId` de `plugin.json`.
2. Recharger AnythingLLM (Ctrl+R) : la skill « Wiki Sea of Thieves » apparaît dans
   *Paramètres > Compétences de l'agent*. L'activer.
3. Tester dans un workspace : `@agent quel est le bateau de Flameheart ?`

Les modifications de `handler.js` sont prises en compte à chaud ; si une session d'agent est
en cours, la quitter avec `/exit`.

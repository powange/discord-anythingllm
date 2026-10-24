# discord-anythingllm

Bot Discord qui sert de **pont vers une instance [AnythingLLM](https://anythingllm.com/)** (RAG self-hosted). On parle au bot sur Discord, il interroge un workspace AnythingLLM et renvoie la réponse.

Le bot est **agnostique au contenu** du workspace : il relaie simplement les questions et les réponses.

## Fonctionnement

Le bot répond :

- quand il est **mentionné** (`@bot ma question`) dans un salon,
- en **message privé (DM)**,
- et — si `ALLOWED_CHANNEL_IDS` est renseigné — à **tous les messages** des salons listés.

Il ignore ses propres messages et ceux des autres bots, nettoie sa mention du texte avant d'interroger AnythingLLM, affiche l'indicateur « écrit… » pendant l'attente (le RAG peut dépasser 10 s) et découpe automatiquement les réponses qui dépassent la limite de 2000 caractères de Discord.

Chaque salon utilise un `sessionId` distinct (`discord-<channelId>`) : chaque salon garde donc son propre fil de conversation côté AnythingLLM.

## Variables d'environnement

| Variable                | Obligatoire | Défaut | Description                                                                       |
| ----------------------- | :---------: | :----: | -------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`         |     ✅      |   —    | Token du bot Discord.                                                             |
| `ANYTHINGLLM_URL`       |     ✅      |   —    | URL de l'instance AnythingLLM, **sans slash final** (ex: `https://llm.exemple.com`). |
| `ANYTHINGLLM_API_KEY`   |     ✅      |   —    | Clé API AnythingLLM.                                                              |
| `ANYTHINGLLM_WORKSPACE` |     ✅      |   —    | Slug du workspace (visible dans son URL).                                         |
| `ANYTHINGLLM_MODE`      |     ❌      | `chat`  | `chat` (conversationnel) ou `query` (strictement factuel). `agent` n'est **pas** valide ici. |
| `ANYTHINGLLM_AGENT`     |     ❌      | `false` | `true` pour préfixer chaque question par `@agent` (déclenche les skills/tools/MCP). `fallback` : documents d'abord, `@agent` seulement si rien n'est trouvé. |
| `QUERY_REFUSAL_RESPONSE` | ❌ | réponse par défaut d'AnythingLLM | Mode `fallback` : texte de refus du mode query, à renseigner seulement s'il a été personnalisé dans le workspace. |
| `ALLOWED_CHANNEL_IDS`   |     ❌      |  vide   | IDs de salons (séparés par des virgules) où répondre à tous les messages.         |

Le bot **échoue proprement au démarrage** si une variable obligatoire manque.

## Configuration Discord

1. Va sur le [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Onglet **Bot** → **Reset Token** pour obtenir le `DISCORD_TOKEN`.
3. Toujours dans **Bot**, active **Message Content Intent** (indispensable : sans lui le bot ne lit pas le contenu des messages).
4. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot`
   - Bot Permissions : `View Channels`, `Send Messages`, `Read Message History`
   - Ouvre l'URL générée pour inviter le bot sur ton serveur.

### Intents et partials (déjà configurés dans le code)

- **Intents** : `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`.
- **Partials** : `[Channel]` — nécessaire pour recevoir les messages privés.

## Configuration AnythingLLM

1. Dans AnythingLLM : **Settings → Tools → Developer API → Generate New API Key** → renseigne `ANYTHINGLLM_API_KEY`.
2. Crée (ou choisis) un workspace ; son slug (dans l'URL) donne `ANYTHINGLLM_WORKSPACE`.
3. `ANYTHINGLLM_URL` est l'URL de base de ton instance, **sans slash final**.

Le bot appelle l'endpoint **streaming** (SSE) :

```
POST {ANYTHINGLLM_URL}/api/v1/workspace/{ANYTHINGLLM_WORKSPACE}/stream-chat
Authorization: Bearer {ANYTHINGLLM_API_KEY}
Content-Type: application/json
Accept: text/event-stream

{ "message": "<texte>", "mode": "chat", "sessionId": "discord-<channelId>" }
```

Il accumule les morceaux de texte (`textResponse`) au fil du flux pour composer la réponse, et gère un éventuel champ `error`.

### Mode agent

Le paramètre `mode` de l'API n'accepte que `chat` et `query` : **`agent` n'y est pas une valeur valide**. Pour déclencher l'agent AnythingLLM (skills, tools, MCP), deux options :

- **`ANYTHINGLLM_AGENT=true`** : le bot préfixe chaque question par `@agent`, ce qui invoque l'agent via la Developer API (`ANYTHINGLLM_MODE` reste `chat` ou `query`).
- **`ANYTHINGLLM_AGENT=fallback`** : routage à deux temps (les questions sur un personnage — « qui est… », « parle-moi de… », « PNJ » — vont directement à l'agent et à ses skills, la base ne couvrant pas les personnages). Le bot interroge d'abord en mode `query` (réponse uniquement depuis les documents). Si AnythingLLM répond par son message de refus (aucun document pertinent), le bot rejoue la même question préfixée par `@agent` — par exemple pour déclencher la skill *Web Search*. Pour ce premier passage, le bot ajoute à la question une consigne demandant au modèle de répondre `AUCUNE_INFO` si les documents ne contiennent pas la réponse : c'est ce mot-clé qui déclenche la relance, car AnythingLLM ne renvoie son propre message de refus que si aucun extrait ne passe le seuil de similarité. Ce message de refus est aussi détecté : c'est celui par défaut d'AnythingLLM ; s'il a été personnalisé dans le workspace (*Query mode refusal response*), recopie-le dans `QUERY_REFUSAL_RESPONSE`.
- **Réglage du workspace** : sur un workspace en *Agent mode* (par défaut pour les workspaces récents) avec *native tool calling* supporté par ton provider LLM, l'agent tourne automatiquement — inutile de toucher à `ANYTHINGLLM_AGENT`.

L'agent peut enchaîner **plusieurs skills** sur une même demande (multi-step tool calling). Le bot n'a pas d'interface pour approuver un tool call : privilégie des skills qui s'exécutent sans approbation (c'est le cas de *Web Search*). Avant de brancher le bot, teste la question préfixée par `@agent` directement dans l'interface d'AnythingLLM.

### Statut « réflexion » éphémère

Grâce au streaming, quand l'agent utilise des skills, le bot poste un **message de statut temporaire** (`🔧 …`) qui se met à jour au fil des skills utilisés, puis **se supprime** dès que la réponse définitive est prête. Si l'instance n'émet aucun événement de statut (mode chat simple ou version d'AnythingLLM qui ne les remonte pas via l'API), aucun message temporaire n'apparaît : seul le résultat final est envoyé.

### Synchronisation d'une API externe

Le bot peut alimenter la base de connaissances du workspace à partir d'une API (par défaut celle d'achievements-sot.powange.com). Avec `SOT_API_TOKEN` renseigné, il récupère au démarrage puis toutes les `SOT_SYNC_INTERVAL_HOURS` heures chaque endpoint de `SOT_API_ENDPOINTS` en Markdown (`?format=md`, jeton dans l'en-tête `Authorization`). Il le dépose comme document « SoT API — <endpoint> » via la Developer API d'AnythingLLM, l'ajoute au workspace et retire l'ancienne version. Un contenu inchangé n'est pas ré-embeddé.

L'endpoint `release-notes` est traité à part : le bot lit l'index JSON des versions et crée un document « historique » (qui commence par la dernière version et sa date), puis un document par version via `release-notes/<version>`. Les versions déjà présentes ne sont plus retéléchargées, sauf les 3 plus récentes, revérifiées à chaque tour. Un seul gros document noyait les questions du type « quelle est la dernière version ? » parmi des milliers d'extraits. Un document « Dernière mise à jour » reprend aussi le contenu de la version la plus récente.

L'endpoint `chest-items` est découpé en un document par sous-catégorie (ex. « Navire › Wheel »), précédé d'une introduction expliquant ce qu'est le coffre du pirate (pour que le modèle ne pense pas aux coffres au trésor). Les lignes d'image et les identifiants techniques sont retirés : ils alourdissaient l'indexation sans aider la recherche. Le bot garde en revanche en mémoire la correspondance nom d'objet → image : quand une réponse cite un objet du coffre par son nom exact, il joint son image (4 au maximum) sous forme d'encart Discord.

L'endpoint `recommendations` (les emblèmes du jeu) donne un document « sommaire » des factions et campagnes, puis un document par campagne via `recommendations/<faction>/<campagne>`, avec une introduction expliquant ce que sont les emblèmes. Leurs images sont jointes sur Discord comme celles du coffre.

Deux sources publiques complètent l'API : `steam-news` (annonces officielles de Rare publiées sur Steam, hors notes de version déjà couvertes) et `rarethief-guides` (guides récents du site communautaire Rare Thief). Chacune donne un document par élément et un sommaire daté ; les éléments sortis de la fenêtre (`STEAM_NEWS_DAYS`, `RARETHIEF_DAYS`) sont retirés, pour qu'une vieille annonce ne passe pas pour actuelle.

Quand une question cite un objet du coffre ou un emblème par son nom exact, le bot joint sa fiche (catégorie, description, coût, prérequis ou paliers) à la question envoyée en mode query : la recherche vectorielle retrouve mal un nom propre précis. Les logs le signalent par une ligne `📇`.

Le modèle d'embedding d'AnythingLLM doit être multilingue : le modèle par défaut, all-MiniLM-L6-v2, est entraîné sur l'anglais et rend la recherche quasi aléatoire sur des données en français (scores autour de 0,05 avec `DEBUG=true`). Changer de modèle oblige à tout réindexer : retirer les documents du workspace puis redémarrer le bot. Les logs préfixés `📚` indiquent le résultat de chaque synchro.

| Variable | Défaut | Description |
| --- | --- | --- |
| `SOT_API_TOKEN` | vide | Jeton de l'API. Vide = synchronisation désactivée. |
| `SOT_API_URL` | `https://achievements-sot.powange.com/api/agent` | Base des endpoints. |
| `SOT_API_ENDPOINTS` | `release-notes,chest-items,recommendations,steam-news,rarethief-guides` | Sources à synchroniser, séparées par des virgules. |
| `STEAM_NEWS_DAYS` | `180` | Fenêtre (en jours) des annonces officielles synchronisées. |
| `RARETHIEF_DAYS` | `90` | Fenêtre (en jours) des guides Rare Thief synchronisés. |
| `SOT_SYNC_INTERVAL_HOURS` | `6` | Intervalle entre deux synchronisations. |

N'ajoute pas un endpoint dont le contenu dépend du compte lié au jeton : tous les membres du Discord le recevraient comme une information générale. Les trois endpoints par défaut sont des catalogues communs à tous les joueurs.

### Skills d'agent

Le dossier [`skills`](skills) contient des skills AnythingLLM pour Sea of Thieves : wiki (`sot-wiki`), guides Rare Thief (`sot-guides`), annonces officielles (`sot-news`) et état des serveurs (`sot-status`). Elles s'installent dans AnythingLLM, pas dans le bot : voir le [README des skills](skills/README.md). Le bot envoie directement à l'agent les questions sur les personnages, le lore et l'état des serveurs ; les actualités et guides récents étant synchronisés dans la base, ces questions passent d'abord par le mode query, avec l'agent en relais.

## Lancer en local

```bash
cp .env.example .env   # puis renseigne les valeurs
npm install
npm start
```

## Déploiement avec Docker

```bash
docker compose up -d --build
```

En local, Docker Compose lit automatiquement un fichier `.env` présent à côté du `docker-compose.yml`.

## Déploiement avec Portainer (stack Git)

Le `docker-compose.yml` est prévu pour une **stack Git** Portainer :

1. Pousse ce dépôt sur ton Git (le `.env` n'est **jamais** commité — voir `.gitignore`).
2. Dans Portainer : **Stacks → Add stack → Git Repository**, renseigne l'URL du dépôt et la branche.
3. Dans la section **Environment variables**, ajoute : `DISCORD_TOKEN`, `ANYTHINGLLM_URL`, `ANYTHINGLLM_API_KEY`, `ANYTHINGLLM_WORKSPACE`, et au besoin `ANYTHINGLLM_MODE` / `ALLOWED_CHANNEL_IDS`.
4. **Deploy the stack** : Portainer build l'image depuis le `Dockerfile` (`build: .`) et injecte les variables via l'interpolation `${VAR}` du compose.

> Les secrets ne sont donc **jamais** dans le dépôt : ils vivent uniquement dans l'UI Portainer.

## Point d'attention (bug connu AnythingLLM)

Avec l'authentification par **clé API**, AnythingLLM enregistre les messages **sans utilisateur associé**. Cela peut faire planter une session dont l'historique dépasse la fenêtre de contexte du modèle.

L'usage d'un **`sessionId` par salon** limite le risque (chaque salon a un historique séparé, plus court). En cas de souci sur un salon précis, repartir d'un salon neuf réinitialise la session, ou bascule en mode `query` (moins dépendant de l'historique).

## Dépannage

**Le bot affiche « … est en train d'écrire » mais ne répond jamais.**
Le bot interroge AnythingLLM en streaming ; s'il reste bloqué, active les logs et regarde la sortie du conteneur :

1. mets `DEBUG=true`, redéploie, puis suis les logs : `docker logs -f discord-anythingllm` ;
2. tu verras le statut HTTP, le `content-type` du flux et le détail des premiers événements reçus ;
3. la requête est abandonnée (au lieu d'un « typing » infini, un message d'erreur est posté) si le **1ᵉʳ octet** n'arrive pas sous `FIRST_BYTE_TIMEOUT_MS` (5 min par défaut — laisse le temps à un modèle local de chauffer), ou si le flux reste ensuite **inactif** plus de `STREAM_IDLE_TIMEOUT_MS` (1 min par défaut).

Test rapide de l'API, hors du bot :

```bash
curl -N -X POST "$ANYTHINGLLM_URL/api/v1/workspace/$ANYTHINGLLM_WORKSPACE/stream-chat" \
  -H "Authorization: Bearer $ANYTHINGLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"bonjour","mode":"chat","sessionId":"test"}'
```

Si `curl` ne renvoie rien non plus, le problème est côté AnythingLLM (workspace, modèle non configuré, agent en attente d'approbation d'un tool call…), pas côté bot. En mode agent, teste d'abord `@agent` dans l'interface d'AnythingLLM : un modèle qui ne se charge pas (mémoire insuffisante côté LM Studio) ou qui gère mal les tool calls y apparaît tout de suite.

## Licence

[MIT](LICENSE)

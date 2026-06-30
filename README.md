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
| `ANYTHINGLLM_MODE`      |     ❌      | `chat` | `chat` (conversationnel) ou `query` (strictement factuel).                        |
| `ALLOWED_CHANNEL_IDS`   |     ❌      |  vide  | IDs de salons (séparés par des virgules) où répondre à tous les messages.         |

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

Le bot appelle :

```
POST {ANYTHINGLLM_URL}/api/v1/workspace/{ANYTHINGLLM_WORKSPACE}/chat
Authorization: Bearer {ANYTHINGLLM_API_KEY}
Content-Type: application/json

{ "message": "<texte>", "mode": "chat", "sessionId": "discord-<channelId>" }
```

Il lit le champ `textResponse` de la réponse (et gère un éventuel champ `error`).

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

## Licence

[MIT](LICENSE)

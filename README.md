# Channel reposter

Web application for managing Telegram → MAX reposting. Each registered user manages only their own connections; bot tokens are encrypted at rest and never shown again after saving.

The cabinet has separate Connections, History, and Profile screens. A welcome balance is credited at registration; the configurable tariff is deducted only after MAX confirms a post was published. The owner account (`rodion89@list.ru`) has an admin screen for changing the welcome bonus and tariff, and for manual balance credits. YooKassa payments are enabled after `YOOKASSA_SHOP_ID` and `YOOKASSA_SECRET_KEY` are configured on the server; configure the notification URL as `https://channel.xedoc.ru/webhooks/yookassa` in the YooKassa dashboard.

In **Админка → Пользователи и баланс**, **Открыть кабинет** lets an administrator inspect another account's connections, history and profile without its password. A sticky banner identifies the viewed account and offers **Вернуться в админку**. This mode is read-only: the server blocks mutations, publications, payments and nested account switching, including direct requests and WhatsApp actions. All tabs in the same browser session share the selected account; older forms become invalid when switching. Session and CSRF tokens rotate on entry and return without extending the session lifetime. The administrator's role is rechecked on each request; the user's own sessions stay unchanged. The latest 1,000 entry/return events are stored in `adminAccessLog` with administrator/user IDs and timestamps.

Telegram media groups are buffered for two seconds and published as one MAX message with all image/video attachments. One album creates one history item and one tariff charge. Pending albums are persisted in the state file so a service restart during the buffer window does not lose them. Set `TELEGRAM_ALBUM_SETTLE_MS` only if the default collection window needs adjustment.

History entries whose Telegram source payload was saved can be published to MAX again from the History screen. A replay creates a new MAX post, keeps the original history row with a replay counter, and charges the tariff only after MAX confirms the new publication.

For public Telegram channels, the connection card can load up to ten recent text, photo, video, or album posts. Loading only creates a private list in the cabinet; it never publishes or charges the balance. Each candidate has its own confirmed “Отправить в MAX” action, and the public media URL is refreshed immediately before sending.

`GET /history` automatically loads the latest public Telegram page for the signed-in user's selected connections. The open page refreshes once a minute while visible; per-connection caching and single-flight fetches avoid duplicate source requests. Source posts and delivery records are merged by message/album aliases, with source dates, destination, delivery status, a full-text preview, owner-scoped filters and pagination. “Более ранние посты” follows Telegram's validated older-page cursor. The cache retains up to 500 source posts per connection without evicting other users' posts, preserves cached rows on source failure and is not a complete Telegram export.

Refreshing history, loading older posts, changing filters and previewing content never send messages or change the wallet. Each first publication requires a CSRF-protected POST and a confirmation showing the MAX destination and tariff. Already published posts offer a separate explicit repeat action. Ambiguous/partial sends and unfinished replays remain blocked for reconciliation. Before a first manual send, the source is checked again; unavailable public posts are not sent from stale cached media. A saved original webhook payload takes priority. Manual and webhook deliveries share the same connection queue and alias checks so opening history or double-clicking an imported album cannot publish it twice.

If a WhatsApp destination is saved and the owner's live session is connected, History also offers a separate “Отправить в WhatsApp” action. It uses the existing owner-scoped WhatsApp queue and ledger, works while WhatsApp auto forwarding is off, and never sends to MAX or changes the MAX wallet. WhatsApp published, partial and uncertain results are shown independently for the current saved destination; published or ambiguous posts are not offered for another send.

Links in Telegram post text are sent with MAX link previews enabled. MAX generates the preview automatically from the linked page when it is reachable and provides suitable metadata.

Telegram text entities and rich-message blocks are converted to MAX HTML so supported bold, italic, underline, strikethrough, code, headings, quotations, highlights, and links keep their formatting. Long formatted posts are split into balanced HTML chunks within the MAX message limit.

MAX delivery saves every confirmed part ID immediately. Telegram edits update these parts in place; shortening a post removes its obsolete trailing parts. Legacy multipart IDs are recovered only from an exact consecutive content match beside the original first message. If a historical post grows beyond its existing parts after newer posts have appeared, the edit stops rather than appending a misplaced continuation. An unconfirmed send is recorded before the request and requires channel reconciliation before another attempt; server errors never trigger blind POST retries. Repeated webhooks and edits are serialized before history lookup and charging. A failed or ambiguous partial replay remains blocked until reconciled.

Large Telegram files are routed through an official local Bot API server. Set `TELEGRAM_LOCAL_API_URL`, `TELEGRAM_LOCAL_SOURCES=*`, and `TELEGRAM_LOCAL_FILE_ROOT` to make it the default for all existing and future connections; a comma-separated source allowlist is still supported when a partial rollout is needed. When a new local connection is created, the service first calls the cloud Bot API `logOut` method once and then installs the webhook through the local server. Absolute file paths are accepted only under the configured root and are streamed to MAX from disk.

Telegram WAV audio is transparently transcoded to MP3 before upload: the current MAX audio upload host rejects otherwise valid WAV payloads. The production unit sets `MEDIA_CONVERSION_DIR=/var/lib/channel-reposter/transcode`; FFmpeg must be installed on the host.

## Optional WhatsApp group destination

Each existing connection now has a **Подключить WhatsApp** action. Pair the owner's WhatsApp account with the QR code under Linked devices, then paste an existing group invite link. The account must already belong to the group and have permission to post; the service never joins a group automatically. Saving a group leaves automatic reposting off until enabled separately.

This uses the unofficial Baileys WhatsApp Web client, not Meta Cloud API. Sessions can disconnect and WhatsApp can restrict the account. During this initial integration WhatsApp delivery does not charge the balance; MAX delivery and its existing tariff are unchanged. One Telegram webhook feeds the two independent destinations. Telegram edits are not propagated to WhatsApp. Text and links are retained as plain text, followed by individual media messages; Rich Message layout and Telegram reactions are not reproduced.

Pairing starts only from an authenticated, CSRF-protected POST. QR codes are owner-only and are not persisted or logged. Linked-device authentication is encrypted with `APP_ENCRYPTION_KEY` in `whatsapp/` next to `STATE_PATH` (directory mode 700, files 600). Disconnect stops this service's session and auto forwarding for that account; revoke the linked device in the phone app to revoke it at WhatsApp as well. Startup resumes only previously activated, registered accounts.

**Подготовить архив Telegram** paginates the public feed without publishing. Saved webhook source payloads take priority over public snippets for posts still observed in the public feed. Service notices are excluded. Stored-only records are reported separately and never silently restored into the migration. The resulting report lists unsupported IDs and incomplete scans; it does not imply a complete Telegram export. The existing public parser supports text/photos/videos and up to 12 media items per album. Other formats need saved payloads or a separate export. **Перенести подготовленные посты** sends this reviewed set in chronological order only to WhatsApp, with original date/source URL in the text. The phone account must be connected. A paused batch can be started again: already published items are skipped. All media for each post is fetched before sending (50 files / 100 MiB total maximum).

WhatsApp deliveries have a separate durable ledger, message/album deduplication, a per-account queue, and per-part message IDs. Ambiguous or partial delivery stops the batch and cannot be automatically repeated. Check the group before resolving such an entry; the current UI deliberately does not reset ambiguous entries. A restart pauses an in-progress archive transfer. Routine MAX history replay still sends only to MAX. No test messages are sent by `npm run check`.

Install the pinned dependencies with `npm ci` before starting the service. The existing systemd writable state directory is sufficient; no additional externally exposed port is needed.

## Production setup

### Shared Telegram bot

The Add channel form uses the shared `@MultiPoostBot` by default when its token is configured and an existing connection supplies its webhook. Add the bot as a channel administrator, open its private chat, send `/link`, and confirm the link while signed in to the intended cabinet. The server checks that both the bot and the linked Telegram user administer the source channel before creating a shared connection. When the service MAX bot is configured, neither bot token is required from the user. Old posts are not sent during setup.

`TELEGRAM_SHARED_BOT_TOKEN` optionally selects the shared bot; otherwise the existing `TELEGRAM_BOT_TOKEN` is used. `TELEGRAM_SHARED_BOT_USERNAME` defaults to `MultiPoostBot`. Keep these settings consistent with the bot identity. The original connection remains the webhook endpoint for this bot. Posts are routed only to the unique enabled connection with the same bot token and matching channel; new shared connections also pin the numeric Telegram channel ID. Pausing the original channel does not stop its other channels. Never replace its webhook with a new connection's endpoint.

The expandable own-bot field supports a separate Telegram bot. A token already used by another non-shared connection is rejected. A channel already present in any connection, including a paused one, must be managed through that existing connection.

### Shared MAX bot

With `MAX_APP_BOT_TOKEN`, `MAX_APP_WEBHOOK_SECRET` and `MAX_APP_BOT_USERNAME` configured, the form uses the service MAX bot by default. New connections start disabled with no destination. The owner-only MAX setup page generates a 30-minute `/connect` command. Send it in a private dialog with the service bot, then add that bot to the destination channel and grant publication rights. Return to the setup page and confirm the detected channel. Before activation, the service verifies the MAX user's admin rights, the bot's publication rights, the channel type and ID, and that no other connection already uses the target. Codes are private, expire, rotate and cannot be reassigned to a different MAX account.

Shared `bot_added` events only record a candidate for the matching confirmed MAX user; they never assign a target by themselves. The service webhook subscribes to these events once. Existing connection webhooks for the same MAX bot are routed through the same serialized handler, so duplicate subscriptions cannot attach a new account to an unrelated channel. Removal clears only connections bound to that exact shared-bot destination. Existing destinations are preserved. The own-MAX-bot token and optional target ID remain available in an expandable section.

For a bot already added before setup, forward an existing channel post to the bot's private dialog after confirming the code. The original forwarded `chat_id` becomes a candidate for that confirmed MAX user; ownership and publication rights are still checked on final cabinet confirmation. A matching `bot_admin_permissions_changed` event can also supply the candidate. Forwarding from a group, another MAX account, or without a valid code cannot bind a destination.

Open `https://channel.xedoc.ru/` and register the owner account. The first account automatically receives the pre-existing `@losvprode` → MAX connection. Other users connect through the shared bots as described above, or supply their own bot tokens.

Secrets stay in `/etc/channel-reposter.env` with mode `600`; they are never committed to this repository. `APP_ENCRYPTION_KEY` must be a random base64-encoded 32-byte value and must be backed up before any server migration. The service receives per-connection webhooks:

- Telegram: `POST /webhooks/telegram/{connection-id}`, filtered to the selected source channel;
- MAX: `POST /webhooks/max/{connection-id}`, used to save the channel `chat_id` after the bot is added.

If the target MAX chat ID is left empty, the first `bot_added` event stores it automatically. Add the Telegram bot as an administrator of the source channel and the MAX bot as an administrator of the target channel, then use “Переустановить webhook” in the dashboard.

## MAX mini-app and assistant bot

`GET /max` is the compact Mini Post interface intended to be opened inside MAX. It loads the official MAX Bridge when available and otherwise works as an ordinary responsive web page.

To enable bot commands, add these values only to `/etc/channel-reposter.env` and restart the service:

```text
MAX_APP_BOT_TOKEN=<fresh MAX token>
MAX_APP_WEBHOOK_SECRET=<random A-Za-z0-9_- secret>
MAX_APP_BOT_USERNAME=se13980695_bot
```

At startup the service registers the command menu and the protected webhook `https://channel.xedoc.ru/webhooks/max/app`. The bot supports `/start`, `/cabinet`, `/connect`, `/status`, and `/help`. Do not put the token into a chat, repository, or browser URL.

If a MAX token is rotated, replace it for the existing repost direction using the “Заменить токен MAX” form on the connection card. The token is sealed before it is saved and its webhook subscription is refreshed automatically.

## Dashboard overview

`GET /dashboard` shows Telegram as the source and MAX / WhatsApp as destinations for each connection. WhatsApp status uses the current client session as well as the saved group; a saved group alone does not mean the account is connected. Setup, token rotation and archived post selection remain available in expandable sections.

Statistics use the signed-in user's saved history only. Successful MAX posts include recovered replays; old MAX records do not retain a reliable multipart message count. WhatsApp counts fully published source posts and separately counts confirmed message IDs, including confirmed parts of a partial delivery. An uncertain attempt without an acknowledgment is never counted as a delivered message.

Historical failures can be acknowledged administratively with `issueAcknowledgedAt` on the specific delivery rows. The dashboard excludes those saved failures from its issue counters; the original status, error, message IDs and retry protections remain intact. A failure updated after acknowledgment counts again. Acknowledgment does not send messages or mark a delivery successful.

The calendar supports `month=YYYY-MM`, `day=YYYY-MM-DD` and `view=posts|deliveries`. Publication dates come from Telegram and are deduplicated across destinations and album aliases. Old records without an original date use their first processing date, marked with `≈`. Delivery view uses confirmed delivery dates. Both views use `Asia/Yekaterinburg` (UTC+5), represent retained history rather than all-time analytics, and do not include future scheduling.

## Development check

```powershell
npm run check
```

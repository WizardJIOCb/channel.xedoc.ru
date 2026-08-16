# Channel reposter

Web application for managing Telegram → MAX reposting. Each registered user manages only their own connections; bot tokens are encrypted at rest and never shown again after saving.

The cabinet has separate Connections, History, and Profile screens. A welcome balance is credited at registration; the configurable tariff is deducted only after MAX confirms a post was published. The owner account (`rodion89@list.ru`) has an admin screen for changing the welcome bonus and tariff, and for manual balance credits. YooKassa payments are enabled after `YOOKASSA_SHOP_ID` and `YOOKASSA_SECRET_KEY` are configured on the server; configure the notification URL as `https://channel.xedoc.ru/webhooks/yookassa` in the YooKassa dashboard.

## Production setup

Open `https://channel.xedoc.ru/` and register the owner account. The first account automatically receives the pre-existing `@losvprode` → MAX connection. Other users create their own connection in the dashboard by supplying their Telegram bot token, source channel, MAX bot token, and (optionally) the MAX target chat ID.

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

## Development check

```powershell
npm run check
```

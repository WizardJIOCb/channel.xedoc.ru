# Channel reposter

Web application for managing Telegram → MAX reposting. Each registered user manages only their own connections; bot tokens are encrypted at rest and never shown again after saving.

## Production setup

Open `https://channel.xedoc.ru/` and register the owner account. The first account automatically receives the pre-existing `@losvprode` → MAX connection. Other users create their own connection in the dashboard by supplying their Telegram bot token, source channel, MAX bot token, and (optionally) the MAX target chat ID.

Secrets stay in `/etc/channel-reposter.env` with mode `600`; they are never committed to this repository. `APP_ENCRYPTION_KEY` must be a random base64-encoded 32-byte value and must be backed up before any server migration. The service receives per-connection webhooks:

- Telegram: `POST /webhooks/telegram/{connection-id}`, filtered to the selected source channel;
- MAX: `POST /webhooks/max/{connection-id}`, used to save the channel `chat_id` after the bot is added.

If the target MAX chat ID is left empty, the first `bot_added` event stores it automatically. Add the Telegram bot as an administrator of the source channel and the MAX bot as an administrator of the target channel, then use “Переустановить webhook” in the dashboard.

## Development check

```powershell
npm run check
```

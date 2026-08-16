const required = ['PUBLIC_BASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'MAX_BOT_TOKEN', 'MAX_WEBHOOK_SECRET'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');

const telegramResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${baseUrl}/webhooks/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['channel_post'],
    drop_pending_updates: false,
  }),
});
const telegramPayload = await telegramResponse.json();
if (!telegramResponse.ok || !telegramPayload.ok) throw new Error(`Telegram webhook failed: ${JSON.stringify(telegramPayload)}`);

const maxResponse = await fetch('https://platform-api2.max.ru/subscriptions', {
  method: 'POST',
  headers: { Authorization: process.env.MAX_BOT_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${baseUrl}/webhooks/max`,
    update_types: ['bot_added', 'bot_removed'],
    secret: process.env.MAX_WEBHOOK_SECRET,
  }),
});
const maxPayload = await maxResponse.json();
if (!maxResponse.ok || !maxPayload.success) throw new Error(`MAX webhook failed: ${JSON.stringify(maxPayload)}`);

console.log('Telegram and MAX webhooks are configured. Re-add the MAX bot to the target channel once to capture its chat ID.');

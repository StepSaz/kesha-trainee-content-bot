async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const siteUrl = process.env.NETLIFY_SITE_URL;

  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  if (!siteUrl) {
    console.error('Error: NETLIFY_SITE_URL not set (e.g. https://your-site.netlify.app)');
    process.exit(1);
  }

  const webhookUrl = `${siteUrl}/.netlify/functions/kesha-boss-background`;
  const apiBase = `https://api.telegram.org/bot${token}`;

  // 1. Set webhook
  console.log(`Setting webhook to: ${webhookUrl}`);
  const webhookRes = await fetch(`${apiBase}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const webhookData = await webhookRes.json() as { ok: boolean; description?: string };
  if (!webhookData.ok) {
    console.error('setWebhook failed:', webhookData.description);
    process.exit(1);
  }
  console.log('✅ Webhook set');

  // 2. Register /boss command in bot command list
  console.log('Registering /boss command...');
  const commandsRes = await fetch(`${apiBase}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'boss', description: 'Опубликовать пост (только для начальника)' },
      ],
    }),
  });
  const commandsData = await commandsRes.json() as { ok: boolean; description?: string };
  if (!commandsData.ok) {
    console.error('setMyCommands failed:', commandsData.description);
    process.exit(1);
  }
  console.log('✅ Commands registered');

  // 3. Verify webhook info
  const infoRes = await fetch(`${apiBase}/getWebhookInfo`);
  const info = await infoRes.json() as { result: { url: string; has_custom_certificate: boolean; pending_update_count: number } };
  console.log('\n=== Webhook Info ===');
  console.log(`URL: ${info.result.url}`);
  console.log(`Pending updates: ${info.result.pending_update_count}`);
  console.log('===================\n');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});

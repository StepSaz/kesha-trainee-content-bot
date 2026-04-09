export interface SendResult {
  success: boolean;
  messageId?: number;
  error?: string;
}

export async function sendToChannel(text: string, chatId?: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const targetChatId = chatId ?? process.env.TELEGRAM_CHAT_ID!;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: targetChatId, text }),
      }
    );

    const data = await response.json() as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!data.ok) {
      return { success: false, error: data.description };
    }

    return { success: true, messageId: data.result?.message_id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

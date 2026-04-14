import Anthropic from "@anthropic-ai/sdk";
import { App, LogLevel } from "@slack/bolt";

const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || "50");

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function askClaude(systemPrompt, userPrompt) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: userPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  });
  return response.content[0].text;
}

// Fetch the last N messages from a channel, including thread replies
async function getChannelHistory(channelId, limit = HISTORY_LIMIT) {
  const result = await slack.client.conversations.history({
    channel: channelId,
    limit,
  });

  const messages = result.messages || [];

  // Obtener hilos de respuesta para mensajes que los tengan
  const messagesWithReplies = await Promise.all(
    messages.map(async (m) => {
      if (m.reply_count && m.reply_count > 0) {
        try {
          const thread = await slack.client.conversations.replies({
            channel: channelId,
            ts: m.ts,
          });
          // El primer mensaje del hilo es el mensaje padre, lo excluimos
          return { ...m, replies: thread.messages.slice(1) };
        } catch {
          return { ...m, replies: [] };
        }
      }
      return { ...m, replies: [] };
    })
  );

  // Recopilar todos los user IDs (mensajes + hilos + menciones)
  const allMessages = messagesWithReplies.flatMap((m) => [m, ...(m.replies || [])]);
  const authorIds = allMessages.map((m) => m.user).filter(Boolean);
  const mentionIds = allMessages.flatMap((m) => {
    const matches = m.text?.matchAll(/<@([A-Z0-9]+)>/g) ?? [];
    return [...matches].map((r) => r[1]);
  });
  const userIds = [...new Set([...authorIds, ...mentionIds])];

  const userMap = {};
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const info = await slack.client.users.info({ user: userId });
        userMap[userId] = info.user?.display_name || info.user?.real_name || userId;
      } catch {
        userMap[userId] = userId;
      }
    })
  );

  const formatMessage = (m, indent = "") => {
    const author = m.user ? (userMap[m.user] || m.user) : "unknown";
    const ts = new Date(parseFloat(m.ts) * 1000).toISOString();
    const text = (m.text || "").replace(
      /<@([A-Z0-9]+)>/g,
      (_, uid) => `@${userMap[uid] || uid}`
    );
    return `${indent}[${ts}] ${author}: ${text}`;
  };

  // Construir historial con hilos indentados debajo de su mensaje padre
  return messagesWithReplies
    .filter((m) => !m.bot_id)
    .reverse()
    .map((m) => {
      const parent = formatMessage(m);
      const replies = (m.replies || [])
        .filter((r) => !r.bot_id)
        .map((r) => formatMessage(r, "  └ "))
        .join("\n");
      return replies ? `${parent}\n${replies}` : parent;
    })
    .join("\n");
}

// Debug: log every incoming event
slack.use(async ({ payload, next }) => {
  console.log("[event]", JSON.stringify(payload, null, 2));
  await next();
});

// Handle @mentions in channels
slack.event("app_mention", async ({ event, say }) => {
  // Strip the bot mention from the message text
  const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!question) {
    await say({ text: "¿En qué te puedo ayudar?", thread_ts: event.ts });
    return;
  }

  try {
    const history = await getChannelHistory(event.channel);

    const systemPrompt = `Eres un asistente de soporte en Slack.
INSTRUCCIONES IMPORTANTES:
- Se te proporciona el historial completo del canal incluyendo mensajes y sus hilos de respuesta (indicados con "└").
- Los hilos de respuesta (└) contienen las SOLUCIONES a preguntas anteriores. Debes leerlos con atención.
- Antes de responder, busca en el historial si la pregunta ya fue resuelta en algún hilo.
- Si encuentras una respuesta previa en un hilo, resúmela claramente.
- Si no hay respuesta previa, indícalo para que un humano pueda ayudar.
- Responde siempre en el mismo idioma en el que te preguntan.`;

    const userPrompt = `Historial reciente del canal (del más antiguo al más nuevo):
---
${history || "(sin mensajes previos)"}
---

Pregunta: ${question}`;

    const reply = await askClaude(systemPrompt, userPrompt);

    await say({ text: reply, thread_ts: event.ts });
  } catch (err) {
    console.error("Error handling mention:", err);
    await say({
      text: "Hubo un error procesando tu pregunta. Inténtalo de nuevo.",
      thread_ts: event.ts,
    });
  }
});

await slack.start();
console.log("Claude Bot running in Socket Mode");
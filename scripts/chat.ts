import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createFlueClient, FlueExecutionError } from '@flue/sdk';

const token = process.env.AGENT_SERVICE_TOKEN;
const localUserId = process.env.AGENT_SERVICE_USER_ID;
if (!token && !localUserId)
  throw new Error(
    'Set AGENT_SERVICE_TOKEN for gateway access or AGENT_SERVICE_USER_ID for direct local dev',
  );
const identityHeaders: Record<string, string> = token
  ? { Authorization: `Bearer ${token}` }
  : { 'X-User-Id': localUserId ?? '' };
const baseUrl = (process.env.AGENT_SERVICE_URL ?? 'http://localhost/agent-service').replace(
  /\/$/,
  '',
);
let chatId = process.argv[2];
if (!chatId) {
  const response = await fetch(`${baseUrl}/chats`, {
    method: 'POST',
    headers: { ...identityHeaders, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Chat creation failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new Error('Invalid chat response');
  }
  chatId = value.id;
}
const client = createFlueClient({
  url: `${baseUrl}/agents/assistant/${chatId}`,
  headers: identityHeaders,
});
console.log(`Chat ${chatId}. /exit — выйти, Ctrl+C во время ответа — остановить.`);
const terminal = createInterface({ input: stdin, output: stdout });
let answering = false;
let terminalClosed = false;
terminal.on('close', () => {
  terminalClosed = true;
});
const prompt = () => {
  if (!terminalClosed) terminal.prompt();
};
terminal.on('SIGINT', () => {
  if (answering) {
    void client.abort().catch(() => console.error('Не удалось отправить остановку'));
  } else {
    terminal.close();
  }
});
try {
  terminal.setPrompt('> ');
  prompt();
  for await (const text of terminal) {
    if (text === '/exit') break;
    if (!text.trim()) {
      prompt();
      continue;
    }
    answering = true;
    try {
      const receipt = await client.send({
        message: { kind: 'user', body: text },
        idempotencyKey: randomUUID(),
      });
      await client.read(receipt, {
        onEvent: (event) => {
          if (event.type === 'message-delta' && event.kind === 'text') stdout.write(event.delta);
        },
      });
      stdout.write('\n');
    } catch (error) {
      console.error(
        error instanceof FlueExecutionError
          ? `Выполнение: ${error.failure}`
          : 'Ошибка отправки или соединения',
      );
    } finally {
      answering = false;
      prompt();
    }
  }
} finally {
  terminal.close();
}

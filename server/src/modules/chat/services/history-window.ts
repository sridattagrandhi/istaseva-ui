/** Max history messages forwarded to the LLM per turn. ~40 messages is
 *  roughly 20 exchanges — comfortably more than any booking flow needs,
 *  small enough that a marathon session can't outgrow the context window. */
export const MAX_HISTORY_MESSAGES = 40;

/**
 * Tail-window the conversation. The client resends the full history every
 * turn with no cap, so a long session would otherwise grow until the LLM
 * rejects the request mid-conversation. The window never starts on an
 * assistant message: cutting mid-exchange would show the model an answer
 * with no question, so when the boundary lands on one we trim forward to
 * the next user message.
 */
export function windowMessages<T extends { role: string }>(messages: T[]): T[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  const tail = messages.slice(-MAX_HISTORY_MESSAGES);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  return firstUser > 0 ? tail.slice(firstUser) : tail;
}

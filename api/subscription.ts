export const CHANNEL_ID = "@vladavtorx";
export const CHANNEL_URL = "https://t.me/vladavtorx";

export type SubscriptionState = "subscribed" | "missing" | "error";

export function membershipState(result: { ok?: boolean; result?: { status?: string; is_member?: boolean } }): SubscriptionState {
  if (!result.ok || !result.result) return "error";
  const member = result.result;
  if (["creator", "administrator", "member"].includes(member.status ?? "")) return "subscribed";
  if (member.status === "restricted" && member.is_member === true) return "subscribed";
  return "missing";
}

export async function checkSubscription(token: string, userId: number): Promise<SubscriptionState> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHANNEL_ID, user_id: userId }),
      signal: AbortSignal.timeout(5000),
    });
    return membershipState(await response.json());
  } catch {
    return "error";
  }
}

export const subscriptionText = (state: SubscriptionState) => state === "error"
  ? "😵 Не могу щас проверить подписку. Чутка позже нажми ещё раз."
  : "👀 Стоп, бро. Сперва залетай в канал влад.автора — без подписки я тут не работаю.\n\nПодпишешься — жми «Проверить подписку», и погнали.";

export const subscriptionKeyboard = () => ({ inline_keyboard: [
  [{ text: "📣 Подписаться на канал", url: CHANNEL_URL }],
  [{ text: "✅ Проверить подписку", callback_data: "subcheck" }],
] });

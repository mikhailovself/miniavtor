// Режим подъёбов включается кодом, а не моделью, и только в двух случаях:
//  1) собеседник уже ROAST_AFTER раз подряд оскорбил бота (серия считается в webhook.ts);
//  2) собеседник прямо просит прожарить, подъебнуть, выматерить.
// Обычное несогласие, спор и нытьё режим не включают: там работает обычный тон персонажа.
export const ROAST_AFTER = 3;

export type RoastTrigger =
  | { reason: "insults"; count: number } // count: какой по счёту выпад подряд
  | { reason: "request" };

const insult = /(?:туп(?:ой|ая|ое)|идиот|дебил|дурак|лох|чмо|долбо[её]б|у[её]бок|еблан|мудил|пиздабол|бесполезн|заткнись|соси|пош[её]л\s+на[хx]уй|иди\s+на[хx]уй)/iu;
const directedInsult = /(?:^|[\s,.!?])(?:ты|бот|ботяра|миниавтор|минимавтор|автор)(?:[\s,.!?]+(?:же|ну|такой|самый|просто|вообще|реально|редкостный)){0,2}[\s,.!?]+(?:туп(?:ой|ая|ое)|идиот|дебил|дурак|лох|чмо|долбо[её]б|у[её]бок|еблан|мудил|пиздабол|бесполезн)/iu;
const roastRequest = /(?:^|[\s,.!?])(?:про[жг]ар(?:ь|ьте|ка)|подъ[её]б(?:и|ни|ите|ните)|унизь|оскорби|об?матер(?:и|ите)|по?матерись|заматерись)(?=[\s,.!?]|$)/iu;

export function isInsultToBot(text: string, addressed: boolean): boolean {
  const value = text.trim().toLowerCase();
  if (!addressed || !insult.test(value)) return false;
  return directedInsult.test(value) || /^(?:ну\s+)?(?:туп(?:ой|ая|ое)|идиот|дебил|дурак|лох|чмо|долбо[её]б|у[её]бок|еблан|мудила|пиздабол|заткнись|соси|пош[её]л\s+на[хx]уй|иди\s+на[хx]уй)[!?.\s]*$/iu.test(value);
}

export const isRoastRequest = (text: string, addressed: boolean): boolean =>
  addressed && roastRequest.test(text.toLowerCase());

// insultCount: длина текущей серии оскорблений (0, если это сообщение не оскорбление).
export function roastTrigger(text: string, addressed: boolean, insultCount: number): RoastTrigger | null {
  if (insultCount >= ROAST_AFTER) return { reason: "insults", count: insultCount };
  if (isRoastRequest(text, addressed)) return { reason: "request" };
  return null;
}

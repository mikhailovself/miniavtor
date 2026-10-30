// A roast is earned by repeated insults directed at the bot, not by ordinary disagreement.
const insult = /(?:туп(?:ой|ая|ое)|идиот|дебил|дурак|лох|чмо|долбо[её]б|у[её]бок|еблан|мудил|пиздабол|бесполезн|заткнись|соси|пош[её]л\s+на[хx]уй|иди\s+на[хx]уй)/iu;
const directedInsult = /(?:^|[\s,.!?])(?:ты|бот|ботяра|миниавтор|минимавтор|автор)(?:[\s,.!?]+(?:же|ну|такой|самый|просто|вообще|реально|редкостный)){0,2}[\s,.!?]+(?:туп(?:ой|ая|ое)|идиот|дебил|дурак|лох|чмо|долбо[её]б|у[её]бок|еблан|мудил|пиздабол|бесполезн)/iu;

export function isInsultToBot(text: string, addressed: boolean): boolean {
  const value = text.trim().toLowerCase();
  if (!addressed || !insult.test(value)) return false;
  return directedInsult.test(value) || /^(?:ну\s+)?(?:туп(?:ой|ая|ое)|идиот|дебил|дурак|лох|чмо|долбо[её]б|у[её]бок|еблан|мудила|пиздабол|заткнись|соси|пош[её]л\s+на[хx]уй|иди\s+на[хx]уй)[!?.\s]*$/iu.test(value);
}

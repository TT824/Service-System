/**
 * Intent classification: whether a customer's message asks something, or is
 * social noise the store need not search its knowledge for.
 *
 * **This module exists because the rest of the platform deliberately has no
 * intent.** Every other layer keys its behaviour to what a message *is* —
 * inbound or outbound, which channel, which source — and never to what it
 * *wants*; `reports.ts` records that absence around §4.8 as a design decision.
 * The workspace's assist panel is the one caller that needs the distinction: a
 * greeting must not spend an embedding call, a BM25 query and a model call to
 * answer, and a question must not be answered with the phrase a store wrote for
 * browsers.
 *
 * **The rule is a closed set, and it fails open.** A message is `chitchat` only
 * when it is made up *entirely* of known social tokens — a greeting, a thanks,
 * an acknowledgement, laughter — and carries no question marker at all.
 * Everything else, including every sentence this module has never seen, is
 * `question`. The direction is deliberate: calling a question `chitchat` is what
 * loses an answer, while calling a greeting `question` only spends a retrieval
 * that comes back with nothing. The two mistakes are not the same size, so the
 * door is closed against the expensive one.
 *
 * **A wordless message is chitchat, and a blank one is not.** A lone emoji or a
 * run of 「。。。」 has no words to retrieve on, but it is not a question either;
 * recording it as `chitchat` is what lets the panel say "nothing was searched"
 * instead of showing an empty candidate list with no explanation. A bare 「？」 is
 * deliberately *not* in this group — it is the customer pressing for an answer,
 * and the punctuation check below reads it as a question. Genuinely empty text is
 * a third input: that is the placeholder-message path whose reason is
 * `empty_query`, and this module does not answer for it.
 *
 * Classification reads the text and nothing else: no model, no table. It is a
 * pure function because the question "should this message cost a model call"
 * cannot be answered by a model call — with no provider configured, that
 * decision still has to be made.
 */

import type { ConversationIntent } from './types';

/** Question punctuation: found in the raw text, before normalization strips it. */
const QUESTION_PUNCTUATION: ReadonlyArray<string> = ['?', '？'];

/**
 * Question words, matched against the normalized text.
 *
 * There is no product vocabulary here — no 「发货」, no 「价格」. Those belong to
 * retrieval, not to classification: 「发货」 does not mean the message asks
 * anything (「已经发货了」 states a fact), and admitting them would drift the
 * question from "is this a question" to "does this look like a product enquiry",
 * which is a different module's job.
 */
const QUESTION_WORDS: ReadonlyArray<string> = [
  '吗',
  '呢',
  '怎么',
  '怎样',
  '咋',
  '多少',
  '什么',
  '为什么',
  '为何',
  '哪',
  '几',
  '是否',
  '能不能',
  '可不可以',
  '有没有',
  '如何',
  '何时',
  '请问',
  '求问',
  '问下',
  'how',
  'what',
  'when',
  'where',
  'which',
  'why',
];

/**
 * The social vocabulary: a message made only of these words is chitchat.
 *
 * The list is closed, and the words are compared after normalization (lowercase,
 * no punctuation, no whitespace) — so 「你好，在吗？」 can never reach it: it
 * carries a question mark and was already answered `question` a step earlier.
 */
const SOCIAL_VOCABULARY: ReadonlyArray<string> = [
  '您好',
  '你好',
  '哈喽',
  '嗨',
  '亲',
  '亲爱的',
  '谢谢',
  '多谢',
  '感谢',
  '辛苦了',
  '辛苦',
  '好的',
  '好嘞',
  '好',
  '收到',
  '明白',
  '嗯',
  '哦',
  '哈哈',
  '呵呵',
  '嘿嘿',
  '嘻嘻',
  '拜拜',
  '再见',
  '没事',
  '不用了',
  '打扰了',
  '在的',
  '在呢',
  'hello',
  'hey',
  'hi',
  'ok',
  'okay',
  'thanks',
  'thankyou',
];

/** The vocabulary longest-first, so 「辛苦了」 is consumed before 「辛苦」. */
const SOCIAL_PHRASES: ReadonlyArray<string> = [...SOCIAL_VOCABULARY].sort(
  (left, right) => right.length - left.length,
);

/** What normalization keeps: latin letters, digits and CJK. Everything else goes. */
const KEPT_CHARACTER = /[a-z0-9一-鿿]/g;

/**
 * Classify one customer message.
 *
 * @param text - The customer's newest message text, or a caller-supplied query.
 * @returns `chitchat` only when the message is entirely social; `question`
 *   otherwise, and also when the text is empty.
 */
export function classifyIntent(text: string): ConversationIntent {
  const raw = text.toLowerCase();

  for (const punctuation of QUESTION_PUNCTUATION) {
    if (raw.includes(punctuation)) {
      return 'question';
    }
  }

  const normalized = normalize(raw);
  if (normalized.length === 0) {
    // Text was there and normalization left nothing: one emoji, or punctuation
    // only. No words to retrieve on, and not a question either. Empty text is
    // another matter — that is the placeholder path, and `empty_query` says so.
    return raw.trim().length === 0 ? 'question' : 'chitchat';
  }

  for (const word of QUESTION_WORDS) {
    if (normalized.includes(word)) {
      return 'question';
    }
  }

  return isSocialOnly(normalized) ? 'chitchat' : 'question';
}

/** Lowercase, then keep only letters, digits and CJK. */
function normalize(text: string): string {
  return (text.match(KEPT_CHARACTER) ?? []).join('');
}

/**
 * Whether the social vocabulary can consume the whole of a normalized text.
 *
 * Greedy rather than exhaustive: the list is longest-first, so 「辛苦了」 matches
 * before 「辛苦」 and 「辛苦了好嘞」 is consumed as two phrases rather than being
 * stranded on 「了好嘞」. Any residue answers `false` — which is the point of the
 * function: it admits a completely social message and nothing else.
 */
function isSocialOnly(text: string): boolean {
  let rest = text;
  while (rest.length > 0) {
    const phrase = SOCIAL_PHRASES.find((candidate) => rest.startsWith(candidate));
    if (phrase === undefined) {
      return false;
    }
    rest = rest.slice(phrase.length);
  }
  return true;
}

import { describe, expect, it } from 'vitest';
import { classifyIntent } from './intent';

describe('classifyIntent', () => {
  it('reads a message made only of social words as chitchat', () => {
    const social = [
      '你好',
      '您好！',
      '在的',
      '谢谢',
      '多谢',
      '辛苦了',
      '好的',
      '好嘞',
      '收到',
      '嗯嗯',
      '哈哈',
      'hi',
      'hello',
      'OK',
      'thanks',
      'thank you',
    ];
    for (const text of social) {
      expect(classifyIntent(text), text).toBe('chitchat');
    }
  });

  it('reads an emoji or a run of dots as chitchat', () => {
    // No words to retrieve on, and not a question either. The panel says nothing
    // was searched rather than showing an unexplained empty list.
    for (const text of ['😊', '😊😊', '。。。', '～～', '   ']) {
      expect(classifyIntent(text), text).toBe(text.trim().length === 0 ? 'question' : 'chitchat');
    }
  });

  it('reads a bare question mark as a question, not as wordless', () => {
    // 「？」 is the customer pressing for an answer. It is punctuation, and it is
    // not social noise.
    expect(classifyIntent('？')).toBe('question');
    expect(classifyIntent('？？？')).toBe('question');
  });

  it('reads a question as a question, whatever the words are', () => {
    const questions = [
      '什么时候发货',
      '有货吗',
      '在吗',
      '可以便宜点吗',
      '尺码怎么选',
      '这款多少钱',
      'how much is it',
      '什么时候能到?',
      '请问发货了吗',
    ];
    for (const text of questions) {
      expect(classifyIntent(text), text).toBe('question');
    }
  });

  it('reads a message that starts socially and then goes on as a question', () => {
    // The case the closed vocabulary exists for. 「好的，谢谢」 is social; the
    // clause after it is not, and a classifier that matched on the greeting alone
    // would skip the retrieval this message needs.
    expect(classifyIntent('好的，谢谢，不过我还有个问题')).toBe('question');
    expect(classifyIntent('你好我想问下尺码')).toBe('question');
    expect(classifyIntent('在的，帮我看看这个订单')).toBe('question');
  });

  it('reads empty text as a question, leaving the placeholder path alone', () => {
    // Not this module's call: an empty query is the voice-note placeholder, and
    // `empty_query` is the reason that path records. Answering `chitchat` here
    // would relabel that case and lose the distinction.
    expect(classifyIntent('')).toBe('question');
  });

  it('fails open on anything it has never seen', () => {
    // Every one of these is a sentence the vocabulary does not know. None is a
    // question by its words, and all of them are `question` by the rule: the
    // cost of a needless retrieval is a wasted call, the cost of a missed one is
    // an unanswered customer.
    for (const text of ['帮我改成黑色', '订单 12345', '收到货了', '包装挺好的']) {
      expect(classifyIntent(text), text).toBe('question');
    }
  });
});

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Member, PersonalPhrase, PersonalPhrasePatch } from '@kefu/core';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';

/**
 * Field limits for a personal phrase, mirroring the form on the phrases page.
 *
 * The page's `maxlength` attributes are what an agent actually meets, so the
 * server refuses the same lengths rather than trusting the form to have done it.
 * A phrase is private to its author, so these are not a security boundary —
 * they are here so that a request written by hand cannot store a row the UI
 * would then render badly, and so the two ends of the contract agree on a
 * number.
 */
export const PERSONAL_PHRASE_LIMITS = {
  title: 60,
  category: 30,
  text: 2000,
  keyword: 30,
  keywords: 20,
} as const;

/** Input used to create a personal quick phrase. */
export type CreatePersonalPhraseInput = {
  readonly category: string;
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly text: string;
};

/**
 * Personal quick phrases: the canned replies one agent keeps for themselves.
 *
 * The owner is never a parameter of a request. Every method below takes the
 * resolved {@link Member} and passes its `id` to the repository, which puts it
 * in the `WHERE` clause, and no method takes a member id from the body — a
 * request cannot name whose phrases it is reading or writing, so it cannot ask
 * for somebody else's even by accident.
 *
 * There is no `requireConfigurator` here on purpose. Knowledge writes belong to
 * the tenant administrator; a personal phrase is not tenant data, and the agent
 * who writes the replies is exactly who should be allowed to keep a shortcut to
 * them. An administrator has no more authority over another seat's list than a
 * colleague does.
 */
@Injectable()
export class PersonalPhrasesService {
  /**
   * @param repository - The platform fact source every phrase is read from and
   * written to.
   */
  constructor(@Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository) {}

  /** The asking member's own phrases, newest first. */
  list(tenantId: string, member: Member): Promise<ReadonlyArray<PersonalPhrase>> {
    return this.repository.listPersonalPhrases(tenantId, member.id);
  }

  /**
   * One of the asking member's phrases.
   *
   * @throws {NotFoundException} When the id is unknown **or** belongs to another
   * member: both answer the same, so the response cannot be used to probe
   * whether a colleague has a phrase with that id.
   */
  async get(tenantId: string, member: Member, phraseId: string): Promise<PersonalPhrase> {
    const phrase = await this.repository.getPersonalPhrase(tenantId, member.id, phraseId);
    if (phrase === undefined) {
      throw new NotFoundException('personal phrase not found');
    }
    return phrase;
  }

  /** Create a phrase owned by the asking member. */
  create(
    tenantId: string,
    member: Member,
    input: CreatePersonalPhraseInput,
  ): Promise<PersonalPhrase> {
    return this.repository.createPersonalPhrase({
      tenantId,
      memberId: member.id,
      category: within('category', input.category, PERSONAL_PHRASE_LIMITS.category),
      title: within('title', input.title, PERSONAL_PHRASE_LIMITS.title),
      keywords: keywordsWithin(input.keywords),
      text: within('text', input.text, PERSONAL_PHRASE_LIMITS.text),
    });
  }

  /**
   * Change one of the asking member's phrases.
   *
   * An empty patch is refused rather than treated as a no-op: a `PATCH` that
   * changes nothing is far more likely to be a caller that built the wrong
   * object than a deliberate touch, and answering it with success would hide
   * the mistake.
   *
   * @throws {BadRequestException} When no field was provided.
   * @throws {NotFoundException} When the id is unknown or not the caller's.
   */
  async update(
    tenantId: string,
    member: Member,
    phraseId: string,
    patch: PersonalPhrasePatch,
  ): Promise<PersonalPhrase> {
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('at least one field must be provided');
    }
    const updated = await this.repository.updatePersonalPhrase(
      tenantId,
      member.id,
      phraseId,
      {
        ...(patch.category === undefined
          ? {}
          : { category: within('category', patch.category, PERSONAL_PHRASE_LIMITS.category) }),
        ...(patch.title === undefined
          ? {}
          : { title: within('title', patch.title, PERSONAL_PHRASE_LIMITS.title) }),
        ...(patch.keywords === undefined ? {} : { keywords: keywordsWithin(patch.keywords) }),
        ...(patch.text === undefined
          ? {}
          : { text: within('text', patch.text, PERSONAL_PHRASE_LIMITS.text) }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      },
    );
    if (updated === undefined) {
      throw new NotFoundException('personal phrase not found');
    }
    return updated;
  }
}

/**
 * Refuse a field longer than the form allows.
 *
 * The count is of characters, not bytes, because that is what `maxlength`
 * counts and what the agent typed — a Chinese title of 60 characters is 60 here
 * however many bytes it costs.
 */
function within(field: string, value: string, limit: number): string {
  if ([...value].length > limit) {
    throw new BadRequestException(`${field} must be at most ${String(limit)} characters`);
  }
  return value;
}

/** Every keyword within its own limit, and no more of them than the form sends. */
function keywordsWithin(keywords: ReadonlyArray<string>): ReadonlyArray<string> {
  if (keywords.length > PERSONAL_PHRASE_LIMITS.keywords) {
    throw new BadRequestException(
      `keywords must hold at most ${String(PERSONAL_PHRASE_LIMITS.keywords)} entries`,
    );
  }
  return keywords.map((keyword) => within('keywords', keyword, PERSONAL_PHRASE_LIMITS.keyword));
}

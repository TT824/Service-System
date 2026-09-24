import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  applyRerankOrder,
  CONTENT_SAFETY_RULES,
  CUSTOMER_VISIBLE_SKU_ATTRIBUTES,
  CUSTOMER_VISIBLE_SKU_FACTS,
  CUSTOMER_VISIBLE_SPU_ATTRIBUTES,
  clampSuggestionLimit,
  constrainRecallByAttribute,
  fuseRecall,
  generateSuggestions,
  GENERATION_PROVIDER,
  isChannelMessagePlaceholder,
  KNOWLEDGE_FUSION_TOP,
  KNOWLEDGE_RERANK_CANDIDATES,
  labelledEntries,
  parseKnowledgeQuery,
  RERANK_PROVIDER,
  screenCandidates,
  SUGGESTION_FALLBACK_REASONS,
  toAttributeMap,
  usableKnowledge,
  type AttributeConstraint,
  type ContentSafetyRule,
  type Conversation,
  type FusedRecallHit,
  type GeneratedCandidate,
  type GenerationProvider,
  type Member,
  type ProductSku,
  type ProductSpu,
  type RecalledChunk,
  type RerankProvider,
  type RetrievableKnowledge,
  type SuggestionCandidate,
  type SuggestionSet,
} from '@kefu/core';
import { JsonLogger } from '../logging/json-logger';
import { AccessService } from '../platform/access.service';
import {
  PLATFORM_REPOSITORY,
  type CreateSuggestionSetRecord,
  type PlatformRepository,
} from '../platform/platform-repository';
import {
  KNOWLEDGE_KEYWORD_RECALL,
  type KnowledgeKeywordRecall,
  type KeywordRecallHit,
} from './knowledge-keyword-recall';
import {
  KNOWLEDGE_SEMANTIC_RECALL,
  type KnowledgeSemanticRecall,
  type SemanticRecallResult,
} from './knowledge-semantic-recall';

/** Retrieval request after body validation. */
export type SuggestRequest = {
  readonly conversationId: string;
  readonly query?: string;
  readonly limit?: number;
};

/** Candidate material for one store, and whether the semantic leg could be asked. */
type StoreKnowledge = {
  readonly entries: ReadonlyArray<RetrievableKnowledge>;
  readonly semanticUnavailable: boolean;
};

/**
 * Retrieval and suggestion behavior.
 *
 * Knowledge reaches the engine down SDD-014's two-lane path: the keyword leg and
 * the semantic leg are asked the same question in parallel, their answers are
 * fused into one ranked list of slices, and each slice's source is read back to
 * get the fields a candidate is made of. What the engine then does with that
 * list — it scores the sources itself and keeps three — is deliberately not this
 * layer's business; what *is* this layer's business is that the rank it worked
 * for arrives with the entry, which it now does (see
 * {@link RetrievalService.knowledgeForStore}).
 *
 * **Two generators, one set, and the set says which wrote it.** The
 * deterministic engine runs entirely on the tenant's own knowledge (products,
 * FAQs, shortcuts) and is always available. A generation provider, when one is
 * configured, is asked as well, and its drafts become the candidates — anchored
 * to the entries they were written from (see {@link RetrievalService.anchor}).
 * The engine runs either way, because it is the answer to every way the provider
 * can fail and it costs a pure function call; what changes is which one the set
 * records. Three outcomes, three honest sets:
 *
 *   * No provider configured — engine candidates, `provider: 'none'`, and the
 *     engine's own `no_generation_provider` reason, so a workbench can say why
 *     nothing was written by a model rather than looking broken.
 *   * A provider that delivered — its drafts, `provider: 'deepseek'`, and only
 *     the fallback reasons that are about the *search* rather than about the
 *     engine's set.
 *   * A provider that did not — engine candidates, `provider: 'none'`, and
 *     `generation_unavailable`, which is deliberately not the same code as "we
 *     never had one": only this one means somebody should look.
 *
 * The semantic recall leg is a different thing again: it calls the embedding
 * service for the query when one is configured, and reports `unavailable` when
 * one is not — which is a fact about the recall, not about the answer, so the
 * keyword leg's slices still come back. That reason reaches the client too, as
 * `semantic_recall_unavailable` in the set's fallback reasons: a whole half of
 * the search not running is not something an agent should have to guess at from
 * a short list.
 *
 * A generated set is persisted before it is returned, so a suggestion a user
 * acted on can be read back later within the same authorization scope.
 */
@Injectable()
export class RetrievalService {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly access: AccessService,
    @Inject(KNOWLEDGE_KEYWORD_RECALL) private readonly keywordRecall: KnowledgeKeywordRecall,
    @Inject(KNOWLEDGE_SEMANTIC_RECALL) private readonly semanticRecall: KnowledgeSemanticRecall,
    /**
     * The rerank provider, or `undefined` when none is configured.
     *
     * Two absences that look alike from here and mean opposite things: no
     * provider configured is a deployment that never wanted a reranker, and its
     * answer is the fused order; a provider that failed is a reranker that is
     * supposed to be running and is not. The first costs nothing and is not
     * reported; the second is logged with its reason, because a silent reranker
     * outage reads exactly like a reranker that is not helping — the same
     * "degrades to something indistinguishable from normal" shape the recall
     * legs' `unavailable` exists to break.
     */
    @Inject(RERANK_PROVIDER) private readonly reranker: RerankProvider | undefined,
    /**
     * The generation provider, or `undefined` when none is configured.
     *
     * `undefined` is a value here rather than an absence — the same reading the
     * worker's module writes down — and this class is the gate that reads it.
     */
    @Inject(GENERATION_PROVIDER) private readonly generation: GenerationProvider | undefined,
    /**
     * The banned-phrase library (§4.5, UC-17), injected rather than imported so
     * that a deployment can substitute its own list and the tests can hand it an
     * empty one. See `content-safety/rules.ts` for why that seam is the point.
     */
    @Inject(CONTENT_SAFETY_RULES) private readonly safetyRules: ReadonlyArray<ContentSafetyRule>,
    private readonly logger: JsonLogger,
  ) {}

  /** Generate and persist a suggestion set for one conversation. */
  async suggest(tenantId: string, member: Member, input: SuggestRequest): Promise<SuggestionSet> {
    const conversation = await this.requireConversationInScope(
      tenantId,
      member,
      input.conversationId,
    );
    const query =
      input.query === undefined
        ? await this.latestInboundText(tenantId, conversation.id)
        : input.query;
    const knowledge = await this.knowledgeForStore(tenantId, conversation.storeId, query);

    // The engine runs first and unconditionally: it is pure, it is instant, and
    // it is the answer to every way the provider can fail. Its candidates are
    // discarded when the provider delivered, which is why the ordering costs
    // nothing worth avoiding.
    const engine = generateSuggestions({
      query,
      knowledge: knowledge.entries,
      providerConfigured: this.generation !== undefined,
      semanticRecallUnavailable: knowledge.semanticUnavailable,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });

    const drafts = await this.draft(tenantId, query, knowledge.entries, input.limit);
    if (drafts !== undefined) {
      return this.persistSet({
        tenantId,
        storeId: conversation.storeId,
        conversationId: conversation.id,
        provider: 'deepseek',
        candidates: drafts,
        // Only the reasons that are about the search itself survive, and they
        // are named one by one rather than filtered against: the engine's other
        // reasons — `no_knowledge_match`, `empty_query`, `no_generation_provider`
        // — are all claims about a set the engine produced, and this is not one.
        // An allow-list rather than a deny-list so that a reason added to the
        // engine later cannot leak into a generated set by being unlisted.
        fallbackReasons: engine.fallbackReasons.filter(
          (reason) => reason === SUGGESTION_FALLBACK_REASONS.semanticRecallUnavailable,
        ),
      });
    }

    // The engine records `no_generation_provider` exactly when there is none, so
    // this list needs no filtering: the branch below adds the one code that only
    // a *configured* provider can earn.
    const fallbackReasons = [...engine.fallbackReasons];
    if (this.generation !== undefined) {
      // Configured, and did not deliver. Deliberately not `no_generation_provider`,
      // which would say the opposite: somebody bought this and it is not working.
      fallbackReasons.push(SUGGESTION_FALLBACK_REASONS.generationUnavailable);
    }

    return this.persistSet({
      tenantId,
      storeId: conversation.storeId,
      conversationId: conversation.id,
      provider: 'none',
      candidates: engine.candidates,
      fallbackReasons,
    });
  }

  /**
   * Screen the candidates and write the set.
   *
   * Both branches above end here, the provider's drafts and the engine's alike,
   * because §4.5's filter is about what may reach a seat and the engine is not
   * a trusted source merely for being local: a tenant's own FAQ can hold a
   * phrase this platform bans, and a seat clicking it would send exactly the
   * text the rule exists to stop.
   *
   * A blocked candidate is dropped rather than annotated. It is not a candidate
   * a seat may pick after a warning — it is text this platform will not send,
   * and offering it with a red border would make the rule a suggestion. What
   * the seat is told is the set-level reason; what the operator is told is the
   * log line, which carries rule ids the persisted vocabulary must not.
   */
  private async persistSet(record: CreateSuggestionSetRecord): Promise<SuggestionSet> {
    const { kept, blocked } = screenCandidates(record.candidates, this.safetyRules);
    if (blocked.length === 0) {
      return this.repository.createSuggestionSet(record);
    }

    this.logger.logStructured(
      'warn',
      'content safety removed suggested candidates',
      {
        tenantId: record.tenantId,
        conversationId: record.conversationId,
        provider: record.provider,
        removed: blocked.length,
        // Rule ids rather than the matched text: a rule id is what an operator
        // edits, and the matched phrase is customer-visible content that has no
        // business in a log line.
        rules: [
          ...new Set(blocked.flatMap((entry) => entry.verdict.hits.map((hit) => hit.ruleId))),
        ],
      },
      'RetrievalService',
    );

    return this.repository.createSuggestionSet({
      ...record,
      candidates: kept,
      fallbackReasons: [...record.fallbackReasons, SUGGESTION_FALLBACK_REASONS.contentBlocked],
    });
  }

  /**
   * The provider's drafts for one question, or `undefined` when there are none.
   *
   * Every way this can come back empty-handed — no provider, entries to anchor
   * to but nothing else, a rejected key, an unreachable service, an answer that
   * named no entry it was given — arrives at the caller as the same `undefined`,
   * because the caller's response to all of them is the same: use the engine's
   * candidates and say so. The provider's own code is logged rather than
   * persisted: it is diagnostic, and the set's vocabulary is a contract.
   *
   * The one branch that short-circuits is an empty knowledge list. The port
   * guarantees every candidate names an entry it was given, so with nothing
   * given there is nothing that could come back — asking would spend a model
   * call to be told what is already known.
   */
  private async draft(
    tenantId: string,
    query: string,
    entries: ReadonlyArray<RetrievableKnowledge>,
    limit: number | undefined,
  ): Promise<ReadonlyArray<SuggestionCandidate> | undefined> {
    const provider = this.generation;
    if (provider === undefined || entries.length === 0) {
      return undefined;
    }
    if (query.trim().length === 0) {
      // The second short-circuit, and the one that carries a requirement: no
      // question means no answer, and a model asked to answer nothing writes
      // something. `latestInboundText` is what leaves a query empty here — the
      // customer's newest message was an image or a voice note, whose content is
      // the platform's placeholder — and the whole point of that guard is that
      // the workspace offers a person the message instead of a draft (§块 3:
      // 占位消息提示人工、不触发候选生成). The engine has already answered this
      // request: no candidates, and the `empty_query` reason on the set.
      return undefined;
    }

    const result = await provider.generate({
      query,
      knowledge: entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
      })),
      limit: clampSuggestionLimit(limit),
    });

    if (!result.ok) {
      this.logger.logStructured(
        'warn',
        'the generation provider did not deliver',
        { tenantId, model: provider.model, code: result.code, reason: result.reason },
        'RetrievalService',
      );
      return undefined;
    }

    const anchored = this.anchor(result.candidates, entries);
    if (anchored.length === 0) {
      this.logger.logStructured(
        'warn',
        'the generation provider answered with no anchored candidate',
        { tenantId, model: provider.model, answered: result.candidates.length },
        'RetrievalService',
      );
      return undefined;
    }
    return anchored;
  }

  /**
   * The provider's drafts as candidates this store can be shown.
   *
   * The provider has already dropped every draft that named an entry it was not
   * given, so the lookup cannot miss in practice; what this decides is everything
   * a candidate *claims*. `tenantId`, `storeId`, `kind` and `title` come from the
   * stored entry and never from the model's answer — the model supplies the
   * sentence and the id, and nothing else. That is what makes "select and send"
   * able to cite a source, and it is why a draft cannot point at another
   * tenant's catalogue however the prompt is answered.
   *
   * `score` is `0`, and that is a statement rather than a gap: the engine's score
   * is its own lexical count, and this text was written, not counted. It reads
   * the same way the engine's `0` does for a recalled entry whose words did not
   * match — not a claim of irrelevance — and the set's `provider` says where the
   * text came from.
   */
  private anchor(
    candidates: ReadonlyArray<GeneratedCandidate>,
    entries: ReadonlyArray<RetrievableKnowledge>,
  ): ReadonlyArray<SuggestionCandidate> {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const anchored: SuggestionCandidate[] = [];
    for (const candidate of candidates) {
      const entry = byId.get(candidate.sourceId);
      if (entry === undefined) {
        continue;
      }
      anchored.push(
        Object.freeze({
          rank: anchored.length + 1,
          kind: entry.kind,
          sourceId: entry.id,
          tenantId: entry.tenantId,
          storeId: entry.storeId,
          title: entry.title,
          content: candidate.content,
          score: 0,
        }),
      );
    }
    return Object.freeze(anchored);
  }

  /** Fetch one persisted suggestion set inside the actor scope. */
  async get(tenantId: string, member: Member, suggestionId: string): Promise<SuggestionSet> {
    const set = await this.repository.getSuggestionSet(tenantId, suggestionId);
    if (set === undefined) {
      throw new NotFoundException('suggestion not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, set.storeId);
    return set;
  }

  private async requireConversationInScope(
    tenantId: string,
    member: Member,
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await this.repository.getConversation(tenantId, conversationId);
    if (conversation === undefined) {
      throw new NotFoundException('conversation not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, conversation.storeId);
    // 建议是给「要回话的人」用的：候选是从这条会话的报文里推出来的，所以只读历史
    // 的那位读者（转交出去的原受理人）在这里也得挡住——他连最新那句顾客的话都不
    // 该看到，更不该看到据它生成的草稿。
    const access = await this.access.conversationReadAccess(tenantId, conversation, member);
    if (access === undefined || access.kind !== 'full') {
      throw new ForbiddenException('conversation is not assigned to this member');
    }
    return conversation;
  }

  private async latestInboundText(tenantId: string, conversationId: string): Promise<string> {
    const messages = await this.repository.listMessages(tenantId, conversationId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined || message.direction !== 'inbound') {
        continue;
      }
      if (message.content.trim().length === 0) {
        continue;
      }
      if (isChannelMessagePlaceholder(message.content)) {
        // The newest thing the customer said has no words in it: an image, a
        // voice note or a file, whose content is the platform's own placeholder.
        // Nothing is suggested for it — a model asked to answer `[语音消息]` is
        // being asked to guess, and a candidate drawn from the *previous*
        // message would be sent as though the voice note had been heard. The
        // placeholder in the transcript is the hand-over to a person, and this
        // empty answer is what makes the workspace stop asking for candidates.
        return '';
      }
      return message.content;
    }
    return '';
  }

  /**
   * The knowledge this store may answer a question with.
   *
   * Two halves, and only one of them is new:
   *
   *   * The **recalled** half is the index's: the two legs' slices, fused,
   *     reranked and read back. It is bounded by construction — the fusion
   *     answers with {@link KNOWLEDGE_RERANK_CANDIDATES} slices, the reranker
   *     reorders those, and the read-back stops at {@link KNOWLEDGE_FUSION_TOP}
   *     entries — so the engine no longer scores an unbounded list for the three
   *     kinds the indexer covers.
   *   * The **product** half is the legacy `products` table, read the way it
   *     always was. The catalogue's own tables do *not* come through it any more:
   *     `product_spus` and `product_skus` are indexed source kinds now, so a
   *     product or a variant reaches this list through the fused half like every
   *     other source — recalled by its title or its attributes, and read back by
   *     {@link RetrievalService.spuKnowledge} with its variants' prices and
   *     stock. The legacy read stays because it is a different table with rows of
   *     its own and a 停用 column of its own; indexing the catalogue does not
   *     retire it.
   *
   * The two halves are concatenated rather than merged, and each recalled entry
   * carries the rank the fusion gave it: the engine ranks what it is given by
   * its own lexical score first (see {@link generateSuggestions}), and the rank
   * decides everything that score cannot — which, for a question whose words
   * appear nowhere in the knowledge, is the whole order.
   *
   * The semantic leg's `unavailable` travels out with them. It is a fact about
   * the recall, not about the answer, so it does not empty anything; it becomes
   * one of the set's fallback reasons, which is the only place a client can be
   * told that half of the search did not run.
   */
  private async knowledgeForStore(
    tenantId: string,
    storeId: string,
    query: string,
  ): Promise<StoreKnowledge> {
    const [products, recalled] = await Promise.all([
      this.productKnowledge(tenantId, storeId),
      this.recalledKnowledge(tenantId, storeId, query),
    ]);
    return {
      entries: [...products, ...recalled.entries],
      semanticUnavailable: recalled.semanticUnavailable,
    };
  }

  /**
   * The slices both legs recalled for one question, as candidate material.
   *
   * The legs run in parallel because neither is the other's fallback: a question
   * whose words match nothing still has a meaning, and a semantic leg that
   * cannot answer (no provider, model server down) says so in `unavailable`
   * rather than emptying the answer — the keyword leg's slices are returned
   * either way.
   *
   * The parser is the kernel's, and it is handed no vocabulary: without one it
   * classifies only the values written as labelled pairs (`尺码 XL`) and leaves
   * the rest to the legs' free-text paths. Supplying the tenant's own indexed
   * keywords as that vocabulary is a read this block does not add.
   */
  private async recalledKnowledge(
    tenantId: string,
    storeId: string,
    query: string,
  ): Promise<StoreKnowledge> {
    const parsed = parseKnowledgeQuery({ text: query });
    const [keyword, semantic] = await Promise.all([
      this.keywordRecall.recall({ tenantId, storeId, query: parsed }),
      this.semanticRecall.recall({
        tenantId,
        storeId,
        text: query,
        negations: parsed.negations.map((negation) => negation.text),
      }),
    ]);
    // Fused at the candidate bound and cut to the answer *after* the reranker,
    // never before: the two are the same list when no reranker runs — fusion
    // sorts and then slices, so asking for twenty and taking five is the same
    // answer as asking for five — and when one does run, the whole list is what
    // it has to reorder. Cutting first would leave the reranker choosing among
    // the five fusion already picked, which is the ranking it was brought in to
    // replace.
    const fused = fuseRecall({ keyword, semantic, limit: KNOWLEDGE_RERANK_CANDIDATES });
    // The buyer's own words, spent on the pool before the reranker is asked about
    // it. A cross-encoder reads the two strings it is given, and 「漫暮黑」 is not
    // 「黑色」 to it — the reading of 2026-09-21 is that it scores literal signals
    // well and colour not at all. The slice's colour is not a reading: it is the
    // labelled column the merchant wrote, and `constrainRecallByAttribute` spends
    // it. It removes, never promotes, and it answers with the pool unchanged when
    // the question names no value in it — so the list the reranker sees is the
    // fused list until there is a fact to act on.
    const constrained = constrainRecallByAttribute({ hits: fused.hits, query });
    if (constrained.mode !== 'none') {
      this.reportAttributeConstraint(storeId, constrained, fused.hits.length);
    }
    const reranked = await this.rerank(query, constrained.hits);
    this.reportRecall(storeId, keyword, semantic, reranked);

    const entries: RetrievableKnowledge[] = [];
    const seen = new Set<string>();
    // Walks the reranked candidates until the answer is full, rather than
    // walking exactly five. Two slices of one source are one entry (see below),
    // so five slices can be four entries — and with twenty candidates in hand
    // there is no reason to answer with four when the sixth candidate would be
    // the fifth entry. The loop stops as soon as it has `KNOWLEDGE_FUSION_TOP`,
    // which in the ordinary case is the same five reads it always was.
    for (const [index, hit] of reranked.entries()) {
      if (entries.length >= KNOWLEDGE_FUSION_TOP) {
        break;
      }
      const entry = await this.sourceKnowledge(tenantId, storeId, hit.chunk);
      if (entry === undefined) {
        continue;
      }
      // Two slices of one source are one candidate here. A FAQ's question and
      // its answer are separate slices and the buyer is owed one entry for them;
      // the first slice to be read back is the one whose evidence was stronger.
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      // The rank is carried, not spent: the engine orders the answer, and it
      // cannot weigh evidence it was never given.
      entries.push({
        ...entry,
        recall: { rank: index + 1, modes: hit.modes },
      });
    }
    return { entries, semanticUnavailable: semantic.unavailable !== null };
  }

  /**
   * Read one slice's source back, inside the answering store's scope.
   *
   * This is the retrieval path's authorization surface. A slice's `source_id` is
   * polymorphic text with no foreign key (`0011`), so the slice cannot be joined
   * to its source and the scope cannot be enforced by the statement that found
   * it: the read that follows is a second, independent chance to get it wrong —
   * which is why the reads below go through tenant-scoped getters and then check
   * the store, rather than through an unchecked `WHERE id = $1`.
   *
   * `undefined` is the refusal, and every refusal is logged where it happens: a
   * slice dropped here and a slice that was never recalled look exactly the same
   * from outside this method.
   */
  private async sourceKnowledge(
    tenantId: string,
    storeId: string,
    chunk: RecalledChunk,
  ): Promise<RetrievableKnowledge | undefined> {
    switch (chunk.sourceKind) {
      case 'faq':
        return this.faqKnowledge(tenantId, storeId, chunk.sourceId);
      case 'faq_variant': {
        const variant = await this.repository.getFaqVariant(tenantId, chunk.sourceId);
        if (variant === undefined) {
          return this.refuse(
            chunk.sourceKind,
            chunk.sourceId,
            'the near-question is not indexed here',
          );
        }
        // The candidate is the FAQ the near-question belongs to: a variant is a
        // second way of asking one question and has no answer of its own to
        // offer, so it must not become a candidate (nor a row in the store).
        return this.faqKnowledge(tenantId, storeId, variant.faqId);
      }
      case 'shortcut':
        return this.shortcutKnowledge(tenantId, storeId, chunk.sourceId);
      case 'product':
        return this.spuKnowledge(tenantId, storeId, chunk.sourceId);
      case 'product_sku':
        return this.skuKnowledge(tenantId, storeId, chunk.sourceId);
      default:
        // `source_kind` is text with no foreign key, held to a vocabulary by
        // `0011`'s CHECK alone — and that vocabulary is the indexer's, so this
        // arm is unreachable while the two agree. It stays because a kind this
        // reader cannot map must be refused rather than folded into one it can:
        // guessing would put a row of unknown provenance in front of an agent as
        // a suggested answer.
        return this.refuse(
          chunk.sourceKind,
          chunk.sourceId,
          'no reader is implemented for this source kind',
        );
    }
  }

  /** One FAQ as candidate material, if this store may answer with it. */
  private async faqKnowledge(
    tenantId: string,
    storeId: string,
    faqId: string,
  ): Promise<RetrievableKnowledge | undefined> {
    const faq = await this.repository.getFaq(tenantId, faqId);
    if (faq === undefined) {
      return this.refuse('faq', faqId, 'not in the tenant scope');
    }
    if (faq.storeId !== storeId) {
      return this.refuse('faq', faqId, 'another store’s entry');
    }
    if (!faq.enabled) {
      return this.refuse('faq', faqId, 'stopped');
    }
    return {
      id: faq.id,
      tenantId: faq.tenantId,
      storeId: faq.storeId,
      kind: 'faq',
      title: faq.question,
      content: faq.answer,
    };
  }

  /** One shortcut as candidate material, if this store may answer with it. */
  private async shortcutKnowledge(
    tenantId: string,
    storeId: string,
    shortcutId: string,
  ): Promise<RetrievableKnowledge | undefined> {
    const shortcut = await this.repository.getShortcut(tenantId, shortcutId);
    if (shortcut === undefined) {
      return this.refuse('shortcut', shortcutId, 'not in the tenant scope');
    }
    if (shortcut.storeId !== null && shortcut.storeId !== storeId) {
      return this.refuse('shortcut', shortcutId, 'another store’s phrase');
    }
    if (!shortcut.enabled) {
      return this.refuse('shortcut', shortcutId, 'stopped');
    }
    return {
      id: shortcut.id,
      tenantId: shortcut.tenantId,
      // A merchant-level phrase names no store of its own, and this read is
      // always "what may answer *this* store" — so it is attributed to the store
      // being answered for. The attribution is where the *candidate* is filed,
      // not where the knowledge came from: the slice keeps the source's own
      // scope, and nothing here writes a tenant-level row back as a store's.
      storeId: shortcut.storeId ?? storeId,
      kind: 'shortcut',
      title: shortcut.title,
      content: shortcut.content,
    };
  }

  /**
   * One product as candidate material, if this store may answer with it.
   *
   * The catalogue's own tables, read through the same tenant-scoped getter and
   * then checked against the answering store, exactly as the FAQ and shortcut
   * reads are — a recalled slice names a source, and the scope is re-established
   * here rather than trusted from the recall.
   *
   * The variants are read along with the product because the answer needs them:
   * "多少钱" and "有货吗" are questions about a *variant*, and a product whose
   * price is in a row this read did not fetch could only be answered vaguely.
   * Which variants those are is decided by the same usability rule as everywhere
   * else, one row at a time — a stopped variant is not offered.
   *
   * @param tenantId - The answering tenant.
   * @param storeId - The answering store.
   * @param spuId - The product the slice named.
   * @param focusSkuId - The variant whose slice was recalled, written first.
   * @returns The candidate, or `undefined` when it may not be answered with.
   */
  private async spuKnowledge(
    tenantId: string,
    storeId: string,
    spuId: string,
    focusSkuId?: string,
  ): Promise<RetrievableKnowledge | undefined> {
    const spu = await this.repository.getSpu(tenantId, spuId);
    if (spu === undefined) {
      return this.refuse('product', spuId, 'not in the tenant scope');
    }
    if (spu.storeId !== storeId) {
      return this.refuse('product', spuId, 'another store’s product');
    }
    // The same non-match the indexer's mapper makes, and for the same reason: an
    // unknown shelf state is not a decision against the customer, and reading it
    // as one would refuse a whole imported catalogue.
    if (spu.shelfStatus === 'off_shelf') {
      return this.refuse('product', spuId, 'taken down');
    }

    // `usableKnowledge` reads `enabled`; a variant carries `status`. The two
    // vocabularies are joined here, at the only place that has both, so the rule
    // itself stays the one place that decides.
    const skus = usableKnowledge(
      (await this.repository.listSkus(tenantId, spuId)).map((sku) => ({
        ...sku,
        enabled: sku.status === 'active',
      })),
    );
    return {
      id: spu.id,
      tenantId: spu.tenantId,
      storeId: spu.storeId,
      kind: 'product',
      title: spu.title,
      content: productCandidateText(spu, skus, focusSkuId),
    };
  }

  /**
   * One variant as candidate material — which is to say, its product.
   *
   * A variant is a second way of naming one product, exactly as a near-question
   * is a second way of asking one FAQ, and it has no answer of its own: the
   * candidate that comes back is the product, with the variant's own dimensions
   * and facts written into the text. Two variants of one product are therefore
   * one candidate and not two of the three — the same collapse
   * {@link RetrievalService.recalledKnowledge} makes by keying on the source it
   * read back.
   *
   * @param tenantId - The answering tenant.
   * @param storeId - The answering store.
   * @param skuId - The variant the slice named.
   * @returns The product's candidate, or `undefined` when it may not be answered with.
   */
  private async skuKnowledge(
    tenantId: string,
    storeId: string,
    skuId: string,
  ): Promise<RetrievableKnowledge | undefined> {
    const sku = await this.repository.getSku(tenantId, skuId);
    if (sku === undefined) {
      return this.refuse('product_sku', skuId, 'not in the tenant scope');
    }
    if (sku.storeId !== storeId) {
      return this.refuse('product_sku', skuId, 'another store’s variant');
    }
    if (sku.status !== 'active') {
      return this.refuse('product_sku', skuId, 'stopped');
    }

    const product = await this.spuKnowledge(tenantId, storeId, sku.spuId, sku.id);
    if (product === undefined) {
      return this.refuse('product_sku', skuId, 'its product may not be answered with');
    }
    return product;
  }

  /**
   * The store's products, read whole.
   *
   * The knowledge reads carry 停用 rows as well — the management surface needs
   * to see them to put them back — so this is the one place the reply pipeline
   * applies the usability rule, through the shared `usableKnowledge`. The same
   * rule is applied slice by slice above, where the read is per source rather
   * than per list.
   */
  private async productKnowledge(
    tenantId: string,
    storeId: string,
  ): Promise<ReadonlyArray<RetrievableKnowledge>> {
    return usableKnowledge(await this.repository.listProducts(tenantId, storeId)).map(
      (product) => ({
        id: product.id,
        tenantId: product.tenantId,
        storeId: product.storeId,
        kind: 'product',
        title: product.title,
        content: product.description,
      }),
    );
  }

  /**
   * Write down a slice this path would not carry, and answer `undefined`.
   *
   * A refusal is a value here rather than an exception: one unreadable slice is
   * one candidate fewer, not a failed answer for the buyer. The line is the only
   * evidence the drop happened at all.
   */
  private refuse(sourceKind: string, sourceId: string, reason: string): undefined {
    this.logger.logStructured(
      'warn',
      'refused a recalled slice',
      { sourceKind, sourceId, reason },
      'RetrievalService',
    );
    return undefined;
  }

  /**
   * One line per recall: both legs' ranks and the fused order.
   *
   * The fusion is the step that cannot be read off either leg, so the line
   * carries the input order *and* the output order: an answer that does not
   * follow from the two lists is a bug that the fused list alone would hide. The
   * RRF scores are left out on purpose — they are comparable within one answer
   * and meaningless across two, and a number in a log invites the other reading.
   */
  /**
   * The reranked order of the fused candidates, or the fused order.
   *
   * Three ways out, and the last two are the same list for different reasons:
   *
   *   * No provider is configured. A deployment that never wanted a reranker
   *     gets the fused order, silently — there is nothing to report, because
   *     nothing was promised.
   *   * A provider ran and failed, or threw. The fused order again, but logged
   *     with the provider's own code and reason. This is the branch the whole
   *     `RerankOutcome` union exists for; the alternative, letting the exception
   *     out, would turn a reranker outage into a retrieval outage.
   *   * A provider ran and answered. {@link applyRerankOrder} reorders, and the
   *     caller cuts to the answer.
   *
   * **The `catch` is not redundant with the provider's own.** The provider
   * reports every failure it can classify, but a port is a promise about a
   * module, not about a socket: this is the read path an agent is waiting on,
   * and the one place that must not be able to fail because an orderer failed.
   * The reason it logs carries neither the question nor any slice — the
   * provider's contract, and the log is the other place it has to hold.
   */
  private async rerank(
    query: string,
    fused: ReadonlyArray<FusedRecallHit>,
  ): Promise<ReadonlyArray<FusedRecallHit>> {
    const reranker = this.reranker;
    if (reranker === undefined || fused.length === 0) {
      return fused;
    }

    let outcome;
    try {
      outcome = await reranker.rerank(
        query,
        fused.map((hit) => hit.chunk.content),
      );
    } catch (error: unknown) {
      this.reportRerankFailure(
        reranker.model,
        'rerank_provider_threw',
        error instanceof Error ? error.name : typeof error,
        fused.length,
      );
      return fused;
    }

    if (!outcome.ok) {
      this.reportRerankFailure(reranker.model, outcome.code, outcome.reason, fused.length);
      return fused;
    }

    return applyRerankOrder(fused, outcome.scores);
  }

  /**
   * One line saying which the pool was cut by, and by how much.
   *
   * Reported for every read where the question named or rejected a value in the
   * pool, including the ones where nothing was dropped — those are the reads
   * that say the constraint is firing and agreeing with fusion, and a run where
   * this line never appears at all is a run where the vocabulary never met the
   * question, which reads identically in the answer.
   *
   * The values themselves are logged rather than the ids: they are the buyer's
   * own words and the catalogue's own values, both of which the operator already
   * holds, and a rule that fires on the wrong value is a fact about the value.
   */
  private reportAttributeConstraint(
    storeId: string,
    constraint: AttributeConstraint,
    candidates: number,
  ): void {
    this.logger.logStructured(
      'info',
      'the attribute constraint read the pool',
      {
        storeId,
        mode: constraint.mode,
        asked: constraint.asked,
        negated: constraint.negated,
        candidates,
        kept: constraint.hits.length,
        dropped: constraint.dropped,
        applied: constraint.applied,
      },
      'RetrievalService',
    );
  }

  /** One line saying the reranker did not run, and why. */
  private reportRerankFailure(
    model: string,
    code: string,
    reason: string,
    candidates: number,
  ): void {
    this.logger.logStructured(
      'warn',
      'the rerank leg did not run; answering with the fused order',
      { model, code, reason, candidates },
      'RetrievalService',
    );
  }

  private reportRecall(
    storeId: string,
    keyword: ReadonlyArray<KeywordRecallHit>,
    semantic: SemanticRecallResult,
    fused: ReadonlyArray<FusedRecallHit>,
  ): void {
    this.logger.logStructured(
      'info',
      'fused the knowledge recall legs',
      {
        storeId,
        keyword: keyword.map((hit, index) => ({ chunkId: hit.chunk.id, rank: index + 1 })),
        semantic: semantic.hits.map((hit, index) => ({ chunkId: hit.chunk.id, rank: index + 1 })),
        semanticUnavailable: semantic.unavailable?.code ?? null,
        fused: fused.map((hit) => ({
          chunkId: hit.chunk.id,
          ranks: hit.ranks,
          modes: hit.modes,
        })),
      },
      'RetrievalService',
    );
  }
}

/**
 * How many variants one candidate's text spells out before it summarises.
 *
 * A product can have more variants than an answer needs — the imported catalogue
 * averages two or three but the tail is longer — and every line here is text a
 * model is handed and an agent reads. The count is in the text when it is cut, so
 * the reader knows the list is short rather than complete.
 */
const PRODUCT_TEXT_MAX_SKUS = 8;

/**
 * The answer text of one product: its name, what it is, and its variants' facts.
 *
 * Written to be *read*, by a person and by a model: the title first, then the
 * product's own attributes one per line, then one line per sellable variant
 * carrying that variant's dimensions and its price and stock. The variant lines
 * are the reason this is not just `title + description` — "多少钱" and "有货吗"
 * are asked about a size or a colour, and a price with no variant attached to it
 * is an answer that has to be guessed at.
 *
 * The attributes come from the same whitelist the indexer slices with, so what
 * reaches a model here is exactly what could have recalled this product, and a
 * cost price is absent from both for the same single reason.
 *
 * @param spu - The product row.
 * @param skus - Its sellable variants, as `usableKnowledge` left them.
 * @param focusSkuId - The variant whose slice was recalled, written first.
 * @returns The candidate's `content`.
 */
function productCandidateText(
  spu: ProductSpu,
  skus: ReadonlyArray<ProductSku>,
  focusSkuId?: string,
): string {
  const lines: string[] = [
    spu.title,
    ...labelledEntries(toAttributeMap(spu.commonAttributes), CUSTOMER_VISIBLE_SPU_ATTRIBUTES),
  ];

  // The recalled variant leads: it is the one the buyer's words pointed at, and
  // the rest is there so the answer can offer an alternative when it is out of
  // stock. Order is otherwise the catalogue's, so two runs agree.
  const ordered =
    focusSkuId === undefined
      ? skus
      : [
          ...skus.filter((sku) => sku.id === focusSkuId),
          ...skus.filter((sku) => sku.id !== focusSkuId),
        ];

  for (const sku of ordered.slice(0, PRODUCT_TEXT_MAX_SKUS)) {
    const parts = [
      ...labelledEntries(toAttributeMap(sku.variant), CUSTOMER_VISIBLE_SKU_ATTRIBUTES),
      ...labelledEntries(toAttributeMap(sku.searchAttributes), CUSTOMER_VISIBLE_SKU_FACTS),
    ];
    if (parts.length > 0) {
      lines.push(parts.join('｜'));
    }
  }
  if (ordered.length > PRODUCT_TEXT_MAX_SKUS) {
    lines.push(`…共 ${ordered.length} 个规格`);
  }

  return lines.join('\n');
}

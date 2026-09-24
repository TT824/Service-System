import { Module } from '@nestjs/common';
import {
  EMBEDDING_HTTP_CLIENT,
  FetchEmbeddingHttpClient,
  FetchGenerationHttpClient,
  FetchRerankHttpClient,
  GENERATION_HTTP_CLIENT,
  GENERATION_PROVIDER,
  RERANK_HTTP_CLIENT,
  RERANK_PROVIDER,
  createDeepSeekGenerationProvider,
  createHttpRerankProvider,
  createOllamaEmbeddingProvider,
  type AppConfig,
  type EmbeddingHttpClient,
  type EmbeddingProvider,
  type GenerationHttpClient,
  type GenerationProvider,
  type RerankHttpClient,
  type RerankProvider,
} from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { ContentSafetyModule } from '../content-safety/content-safety.module';
import { DatabaseService } from '../database/database.service';
import { KNOWLEDGE_KEYWORD_RECALL, type KnowledgeKeywordRecall } from './knowledge-keyword-recall';
import {
  KNOWLEDGE_SEMANTIC_RECALL,
  type KnowledgeSemanticRecall,
} from './knowledge-semantic-recall';
import { PostgresKnowledgeKeywordRecall } from './postgres-knowledge-keyword-recall';
import { PostgresKnowledgeSemanticRecall } from './postgres-knowledge-semantic-recall';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';

/**
 * Injection token carrying the bound {@link EmbeddingProvider}, or `undefined`.
 *
 * `undefined` is a value here, not an absence — the same reading the worker's
 * module writes down: a deployment that configured no embedding service gets no
 * provider, and the semantic recall leg reports `no_embedding_provider` instead
 * of the pipeline refusing to answer at all.
 */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/**
 * Retrieval module.
 *
 * Generates source-aware reply suggestions from the tenant's own knowledge base
 * and persists the suggestion sets for the conversation history.
 *
 * Both recall legs are bound here, and the semantic leg is bound with a provider
 * that may be `undefined`: the *query* is embedded on this side of the system —
 * the index sweep embeds the slices, but nothing else can embed a buyer's
 * question — so a deployment without an embedding service loses the semantic
 * leg's hits rather than its answers.
 *
 * The generation provider is bound the same way and for the same reason: a
 * deployment with no key loses model-written drafts, not suggestions. Nothing
 * else in the system may call it — the worker composes its own providers, and
 * generation is a read-path concern, asked for by an agent looking at a
 * conversation.
 */
@Module({
  imports: [ContentSafetyModule],
  controllers: [RetrievalController],
  providers: [
    RetrievalService,
    {
      provide: KNOWLEDGE_KEYWORD_RECALL,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService): KnowledgeKeywordRecall =>
        new PostgresKnowledgeKeywordRecall(database),
    },
    {
      provide: EMBEDDING_HTTP_CLIENT,
      useFactory: (): EmbeddingHttpClient => new FetchEmbeddingHttpClient(),
    },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [APP_CONFIG, EMBEDDING_HTTP_CLIENT],
      useFactory: (config: AppConfig, http: EmbeddingHttpClient): EmbeddingProvider | undefined =>
        createOllamaEmbeddingProvider(config.embedding, http),
    },
    {
      provide: RERANK_HTTP_CLIENT,
      useFactory: (): RerankHttpClient => new FetchRerankHttpClient(),
    },
    {
      provide: RERANK_PROVIDER,
      inject: [APP_CONFIG, RERANK_HTTP_CLIENT],
      useFactory: (config: AppConfig, http: RerankHttpClient): RerankProvider | undefined =>
        createHttpRerankProvider(config.rerank, http),
    },
    {
      provide: GENERATION_HTTP_CLIENT,
      useFactory: (): GenerationHttpClient => new FetchGenerationHttpClient(),
    },
    {
      provide: GENERATION_PROVIDER,
      inject: [APP_CONFIG, GENERATION_HTTP_CLIENT],
      useFactory: (config: AppConfig, http: GenerationHttpClient): GenerationProvider | undefined =>
        createDeepSeekGenerationProvider(config.generation, http),
    },
    {
      provide: KNOWLEDGE_SEMANTIC_RECALL,
      inject: [DatabaseService, EMBEDDING_PROVIDER],
      useFactory: (
        database: DatabaseService,
        provider: EmbeddingProvider | undefined,
      ): KnowledgeSemanticRecall => new PostgresKnowledgeSemanticRecall(database, provider),
    },
  ],
})
export class RetrievalModule {}

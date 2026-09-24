import { Module } from '@nestjs/common';
import { CONTENT_SAFETY_RULES, DEFAULT_CONTENT_SAFETY_RULES } from '@kefu/core';

/**
 * The banned-phrase rule library, bound once for the whole API.
 *
 * A module rather than a bare import at each call site, because the library is
 * read by two independent gates — candidate generation and outbound sending —
 * that have no other reason to know about each other, and a deployment that
 * substitutes its own list must not have to find both.
 *
 * It is deliberately **not** `@Global()`. Two importers is not a burden, and a
 * global would let a third caller pick the library up without the dependency
 * ever appearing in its module — which is the opposite of what this token is
 * for. See `packages/core/src/content-safety/rules.ts` for why the library is
 * injectable at all.
 */
@Module({
  providers: [{ provide: CONTENT_SAFETY_RULES, useValue: DEFAULT_CONTENT_SAFETY_RULES }],
  exports: [CONTENT_SAFETY_RULES],
})
export class ContentSafetyModule {}

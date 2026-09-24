/**
 * Channel configuration and callback surface.
 *
 * Every authenticated route resolves the acting member and the tenant scope
 * first, then hands the work to {@link ChannelsService} or
 * {@link ChannelDeliveryService}. The services answer with
 * {@link ChannelOutcome} values for expected refusals, and {@link unwrapChannel}
 * is the single place those become the platform's stable
 * `{ request_id, code, message, details }` error envelope.
 *
 * The real transport authenticates with WeCom's `msg_signature` query parameter,
 * a digest over the *raw* request body, which is why these routes read their
 * body from {@link rawBodyOf} rather than from a parsed JSON body. The diagnostic
 * local transport still shares this controller in tests; only the adapter differs.
 *
 * The callback URL handshake is the one route WeCom calls with no platform
 * session at all, so it is `@Public()` in exactly the way the health probes are:
 * it authenticates the *provider* with a digest instead of a member credential,
 * and it answers with the decrypted plaintext rather than the JSON envelope.
 *
 * `POST wecom/webhook` is `@Public()` for the same reason and with the same
 * limit. A real transport is called by a WeCom server that holds no platform
 * session, so the route has to be reachable without an identity — which means
 * the global guard cannot be the thing that authenticates it. It is
 * authenticated *inside* instead, and the transport decides how: a real callback
 * is verified against the provider's digest, and the tenant it writes to is the
 * one the `open_kfid` binding resolved; a Mock callback, which is a local
 * stand-in rather than a provider, keeps the platform identity path and so
 * resolves its member here. Neither branch accepts an unverified credential or
 * falls back to a default identity — see {@link ChannelsController.webhook}.
 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  allowsDemoIdentityHeaders,
  type AppConfig,
  type Member,
  type MessageDelivery,
  type WeComChannelBinding,
} from '@kefu/core';
import { APP_CONFIG } from '../config/app-config.module';
import { bearerTokenOf } from '../auth/bearer-token';
import { bodyRecord, bodyRequiredString } from '../http/request-body';
import { queryString } from '../http/query-param';
import { Public } from '../auth/public-route.decorator';
import { SessionAccessService } from '../auth/session-access.service';
import { rememberVerifiedSession, verifiedSessionOf } from '../auth/verified-identity';
import { AccessService } from '../platform/access.service';
import { ChannelDeliveryService, type DeliveryDetail } from './channel-delivery.service';
import { WecomSyncService } from './wecom-sync.service';
import { WECOM_REAL_TRANSPORT, type WecomRealTransport } from './real-wecom.adapter';
import { type RequestWithRawBody } from './wecom-raw-body';
import {
  ChannelsService,
  MOCK_WECOM_SIGNATURE_HEADER,
  WECOM_SIGNATURE_PARAMETER,
  type ChannelsOverview,
  type WecomConnectionVerdict,
} from './channels.service';
import { unwrapChannel } from './channel-outcome';

/** Channel configuration and transport callback surface. */
@Controller('channels')
export class ChannelsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: AccessService,
    private readonly sessionAccess: SessionAccessService,
    private readonly channels: ChannelsService,
    private readonly delivery: ChannelDeliveryService,
    @Inject(WECOM_REAL_TRANSPORT) private readonly realTransport: WecomRealTransport | null,
    private readonly wecomSync: WecomSyncService,
  ) {}

  /** Report the operational status of each configured channel provider. */
  @Get()
  async overview(@Req() req: Request): Promise<ChannelsOverview> {
    return this.channels.overview(this.access.resolveMember(req));
  }

  /**
   * Bind one provider customer-service account to a scope.
   *
   * The account pair is what an operator reads out of WeCom's own console, and
   * the store is what decides where a callback on that account is written: the
   * tenant comes from the request scope, and the store is checked to be part of
   * it, so a binding can only ever name a scope the caller already acts in.
   *
   * Platform administrators only, and the binding is created `active` — see
   * {@link ChannelsService.createBinding} for why no other state is offered.
   *
   * The body is a JSON object, but it is read from the raw capture rather than
   * from `@Body()`: this path sits under `/api/v1/channels/wecom`, where
   * {@link captureWecomRawBody} takes the request stream before Nest's parsers
   * run — the price of authenticating a provider callback over its exact bytes.
   * A JSON body posted here is therefore one this controller parses itself, the
   * same way the Mock callback branch reads its own.
   */
  @Post('wecom/bindings')
  @HttpCode(HttpStatus.CREATED)
  async createBinding(@Req() req: Request): Promise<WeComChannelBinding> {
    const member = this.access.resolveMember(req);
    this.access.requirePlatformAdmin(member);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = jsonBodyOf(req);
    const storeId = bodyRequiredString(record, 'store_id');
    // Checked before the write rather than by the write: `wecom_channel_bindings`
    // references `stores(id)` alone, so the row itself would accept a store from
    // another tenant and only the read's recheck would stop it resolving.
    await this.access.assertStoreInTenant(tenantId, storeId);
    return unwrapChannel(
      await this.channels.createBinding({
        tenantId,
        storeId,
        corpId: bodyRequiredString(record, 'corp_id'),
        openKfId: bodyRequiredString(record, 'open_kfid'),
      }),
    );
  }

  /**
   * Store the credentials typed on the channel page and connect with them.
   *
   * The five values arrive as a JSON body and are written as given, then *used*:
   * the transport fetches a real token with them before this answers, and the
   * verdict — connected, or the platform-authored reason it is not — is stored
   * beside them and returned. `connected: false` is a `200`: the values were
   * accepted and are in effect, and what failed is the connection, which is the
   * distinction the console's result line exists to draw. A refusal here means
   * the request never got that far — unusable values, a Mock build with no
   * provider to prove anything against, or a deployment already connected to
   * another account.
   *
   * **Platform administrators only.** A stored credential is the identity this
   * whole deployment sends as, not one tenant's setting: the customer-service
   * token is shared by the API and the Worker, so a tenant administrator able to
   * write here could make every other tenant's replies arrive from its own
   * company. The tenant scope is still resolved and handed to the service, which
   * is what a binding — the row the credentials hang off — needs to be written.
   *
   * No value is ever returned, logged or echoed by this route. The response
   * carries a binding id, a boolean, an origin, an instant and a reason this
   * platform wrote.
   */
  @Put('wecom/credentials')
  @HttpCode(HttpStatus.OK)
  async connectWecom(@Req() req: Request): Promise<WecomConnectionVerdict> {
    const member = this.access.resolveMember(req);
    this.access.requirePlatformAdmin(member);
    const tenantId = await this.access.resolveTenantScope(req, member);
    // `jsonBodyOf`, not `bodyRecord(req)`: this path prefix has its raw bytes
    // taken by the callback middleware, so `req.body` is never populated here —
    // reading it would refuse every connect with an empty record.
    const record = jsonBodyOf(req);
    return unwrapChannel(
      await this.channels.connectWecom({
        tenantId,
        values: {
          corpId: bodyRequiredString(record, 'corp_id'),
          kfSecret: bodyRequiredString(record, 'kf_secret'),
          callbackToken: bodyRequiredString(record, 'callback_token'),
          aesKey: bodyRequiredString(record, 'aes_key'),
          openKfId: bodyRequiredString(record, 'open_kfid'),
        },
        updatedBy: member.id,
      }),
    );
  }

  /**
   * Complete WeCom's callback URL verification handshake.
   *
   * WeCom calls this with the `msg_signature`/`timestamp`/`nonce`/`echostr`
   * query parameters and expects the decrypted `echostr` back as plain text
   * within a second. The response is written directly, so it is the plaintext
   * itself — no JSON envelope, no quotes, no BOM and no trailing newline — and a
   * wrong or missing signature is refused with the platform's stable error
   * envelope instead of a plaintext nobody should see.
   *
   * `async` because the credential it authenticates with is read from the store
   * rather than held: the handshake must use the set that is configured *now*,
   * which is the whole point of an operator being able to store one.
   */
  @Public()
  @Get('wecom/callback')
  async callbackVerify(
    @Query() query: Readonly<Record<string, unknown>>,
    @Res() res: Response,
  ): Promise<void> {
    const outcome = await this.channels.verifyCallbackUrl({
      signature: queryString(query, WECOM_SIGNATURE_PARAMETER),
      timestamp: queryString(query, 'timestamp'),
      nonce: queryString(query, 'nonce'),
      echostr: queryString(query, 'echostr'),
    });
    const plaintext = unwrapChannel(outcome);
    res.type('text/plain').send(plaintext);
  }

  /**
   * Push pending outbound messages to real customers.
   *
   * {@link ChannelsService.syncMessages} refuses unconditionally, so this route
   * answers the stable `channel_disabled` error under *every* transport — the
   * Mock one included. That makes the adapters' own `syncMessages`
   * implementations unreachable through HTTP; they exist for the adapter
   * contract, not for this route.
   */
  @Post('wecom/sync')
  sync(@Req() req: Request): never {
    this.access.resolveMember(req);
    return this.channels.syncMessages();
  }

  /**
   * Accept one WeCom inbound message callback.
   *
   * Replays are idempotent per provider event: the original business result is
   * returned and neither a second callback record nor a second message is
   * written. That contract is the same on both transports because both reach one
   * ingest core; only the authentication differs.
   *
   * The route is `@Public()` because a real WeCom server holds no platform
   * session, and the two branches authenticate it themselves:
   *
   * - **Real transport**: the provider's `msg_signature` over the raw bytes is
   *   the only credential a callback can carry, and the tenant/store it writes
   *   to is the one the `open_kfid` binding resolved. No member, no
   *   `x-member-id` header and no default administrator is consulted — a
   *   callback cannot name the tenant it writes to, and an unbound account is
   *   refused before anything is written. A callback that turns out to be a
   *   `kf_msg_or_event` notification is answered the same way — the account is
   *   resolved the same, and the messages the notification asks for are pulled
   *   and ingested before this returns.
   * - **Mock transport**: a local stand-in rather than a provider, so its
   *   callback keeps the platform identity path it has always had. Because the
   *   route is public, the guard no longer verifies a bearer presented here, so
   *   this branch verifies one itself and refuses a request that has no
   *   identity where the demo headers are not accepted either. The default
   *   platform administrator is never an identity a callback may borrow.
   *
   * The body is the raw request bytes and the signature is the `msg_signature`
   * query parameter when the real transport is bound, falling back to the Mock
   * shared-secret header. A real callback signs the raw bytes, so nothing here
   * re-serializes what the adapter authenticates.
   */
  @Public()
  @Post('wecom/webhook')
  async webhook(@Req() req: Request): Promise<unknown> {
    const callback = {
      signature: callbackSignature(req),
      timestamp: queryString(req.query, 'timestamp'),
      nonce: queryString(req.query, 'nonce'),
      rawBody: rawBodyOf(req),
    };
    if (this.realTransport !== null) {
      // The sync service authenticates the digest, decides whether this callback
      // carries the message itself or a `kf_msg_or_event` notification that has
      // to be pulled, and owns the pull. Nothing provider-specific crosses back:
      // what the caller receives is the same ingestion result a direct callback
      // has always returned.
      return unwrapChannel(await this.wecomSync.ingestProviderCallback(callback));
    }
    const member = await this.#callbackMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return unwrapChannel(await this.delivery.ingestWebhook({ member, tenantId, ...callback }));
  }

  /**
   * Resolve the platform identity of a Mock callback.
   *
   * A bearer presented here is verified before it may authorize anything: the
   * global guard returns early for a `@Public()` route, so it is this branch
   * that has to turn the header into a session, exactly as the guard would. A
   * request with no bearer is left to the demo identity path, and where the
   * environment does not accept that path at all there is no identity a
   * callback may act through — the default platform administrator is refused
   * rather than borrowed.
   *
   * @param req - Incoming callback request.
   * @returns The member the Mock callback acts through.
   * @throws {UnauthorizedException} When the environment offers no callback
   * identity and the request presents none.
   */
  async #callbackMember(req: Request): Promise<Member> {
    if (bearerTokenOf(req) !== undefined) {
      if (verifiedSessionOf(req) === undefined) {
        // Throws the domain `AuthError`, which the global auth interceptor
        // projects onto the platform error contract.
        rememberVerifiedSession(req, await this.sessionAccess.resolve(req));
      }
      return this.access.resolveMember(req);
    }
    if (!allowsDemoIdentityHeaders(this.config)) {
      throw new UnauthorizedException('authentication is required');
    }
    return this.access.resolveMember(req);
  }

  /**
   * Apply one WeCom delivery status notification.
   *
   * Idempotent by the provider's own status event id and monotonic in state: a
   * replay is not recorded twice, and a late or stale notification is kept as
   * history without ever moving a delivery backwards. Only a delivery inside the
   * authorized tenant scope is affected.
   */
  @Post('wecom/status')
  async status(@Req() req: Request): Promise<unknown> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return unwrapChannel(
      await this.delivery.applyStatusCallback({
        member,
        tenantId,
        signature: callbackSignature(req),
        timestamp: queryString(req.query, 'timestamp'),
        nonce: queryString(req.query, 'nonce'),
        rawBody: rawBodyOf(req),
      }),
    );
  }

  /** One delivery with its provider attempts, status events and outbox entry. */
  @Get('deliveries/:deliveryId')
  async deliveryDetail(
    @Req() req: Request,
    @Param('deliveryId') deliveryId: string,
  ): Promise<DeliveryDetail> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return unwrapChannel(await this.delivery.deliveryDetail(tenantId, member, deliveryId));
  }

  /**
   * Retry one delivery.
   *
   * Appends an attempt to the same logical message and reuses its outbox entry;
   * it never creates a second platform message. A delivery the platform marked
   * not retryable — most importantly one the provider already accepted — is
   * refused with the stable `409 conflict` envelope, and no adapter is called.
   */
  @Post('deliveries/:deliveryId/retry')
  async retry(
    @Req() req: Request,
    @Param('deliveryId') deliveryId: string,
  ): Promise<MessageDelivery> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return unwrapChannel(await this.delivery.retryDelivery(tenantId, member, deliveryId));
  }
}

/**
 * Read one JSON body posted under the callback prefix.
 *
 * Everything under `/api/v1/channels/wecom` has its bytes taken by
 * {@link captureWecomRawBody} ahead of Nest's parsers, so `@Body()` is empty on
 * those routes and the capture is the only place the body exists. The bytes are
 * parsed here, and a body that is not a JSON object is refused with the same
 * stable `bad_request` envelope the shared body helpers produce — never with a
 * parse error, which would report a caller's typo as a defect in the platform.
 *
 * @param req - Incoming request.
 * @returns The parsed body as a plain object.
 * @throws {BadRequestException} When the body is not a JSON object.
 */
function jsonBodyOf(req: Request): Record<string, unknown> {
  try {
    return bodyRecord(JSON.parse(rawBodyOf(req)) as unknown);
  } catch {
    throw new BadRequestException('request body must be a JSON object');
  }
}

/**
 * Read one callback's raw request body.
 *
 * The bytes are captured by {@link captureWecomRawBody} before any body parser
 * sees them, which is what a real digest over the exact request bytes requires.
 * The fallback exists only for a request that reached the handler without going
 * through that middleware — with no captured bytes, re-serializing the parsed
 * JSON body is the most a Mock-shaped request can honestly provide.
 *
 * @param req - Incoming request.
 * @returns The body exactly as received.
 */
function rawBodyOf(req: Request): string {
  const captured = (req as RequestWithRawBody).rawBody;
  if (Buffer.isBuffer(captured)) {
    return captured.toString('utf8');
  }
  if (typeof captured === 'string') {
    return captured;
  }
  return JSON.stringify(req.body ?? null) ?? 'null';
}

/**
 * Read the signature a callback was authenticated with.
 *
 * The real transport signs with the `msg_signature` query parameter and the
 * Mock transport with a shared-secret header. Both are read here so the
 * controller stays transport-neutral: whichever the bound adapter expects is the
 * one it receives, and the other is absent.
 *
 * @param req - Incoming request.
 * @returns The supplied signature, or `null`.
 */
function callbackSignature(req: Request): string | null {
  return (
    queryString(req.query, WECOM_SIGNATURE_PARAMETER) ??
    req.header(MOCK_WECOM_SIGNATURE_HEADER) ??
    null
  );
}

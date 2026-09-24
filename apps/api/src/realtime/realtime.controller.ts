import {
  Controller,
  InternalServerErrorException,
  Req,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { realtimeEventVisibleTo, type RealtimeEvent } from '@kefu/core';
import { RealtimeScopeGuard } from './realtime-scope.guard';
import { realtimeScopeOf } from './realtime-scope';
import { RealtimeService } from './realtime.service';

/**
 * How often an idle stream is kept alive.
 *
 * An SSE connection is a held-open HTTP response, and every proxy between here
 * and the browser reaps one it considers idle. Fifteen seconds leaves room under
 * the shortest idle timeout in common use (30s) while writing far less traffic
 * than the browser's own reconnect would cost.
 */
export const REALTIME_KEEPALIVE_MS = 15_000;

/**
 * The realtime event stream.
 *
 * One stream per signed-in seat, carrying every frame that seat is allowed to
 * see. Authorization happens once, before a single byte of the stream is
 * written, in {@link RealtimeScopeGuard} — a guard rather than the first lines
 * of this handler, because a handler that throws here would answer `200` with an
 * error *frame* instead of an error response. The guard resolves the scope with
 * the same resolvers the REST readers use, so a seat cannot be told about a
 * store it could not have read, and the check cannot be skipped by keeping a
 * connection open past a permission change (a stream that outlives its
 * authorization is torn down by the client's own reconnect; the frame it might
 * then miss is recovered by the REST re-read it performs on reconnect, which is
 * where the current permission is enforced again).
 *
 * Frames only announce that something changed. The state itself is always read
 * over REST, which is what makes a dropped connection cost nothing: see
 * `@kefu/core`'s `platform/realtime` for the contract.
 */
@Controller('realtime')
@UseGuards(RealtimeScopeGuard)
export class RealtimeController {
  /**
   * @param realtime - The frame publisher to subscribe to.
   */
  constructor(private readonly realtime: RealtimeService) {}

  /**
   * Open the caller's event stream.
   *
   * @param req - The incoming request, carrying the scope the guard resolved.
   * @returns A stream that opens with a handshake frame and stays open.
   * @throws {UnauthorizedException} When the request carries no usable identity.
   * @throws {ForbiddenException} When the member has no seat in this tenant.
   * @throws {BadRequestException} When a platform administrator names no tenant.
   * @throws {NotFoundException} When the named tenant does not exist.
   */
  @Sse()
  stream(@Req() req: Request): Observable<MessageEvent> {
    // Everything the stream needs was resolved once, before the response became
    // an event stream: no repository call happens per frame, so a frame is
    // delivered at the speed of a `write` and nothing else.
    const scope = realtimeScopeOf(req);
    if (scope === undefined) {
      // Unreachable through the routed path, since the guard runs first. Asserted
      // rather than defaulted because the alternative — subscribing with no scope
      // — would mean a filter that admits everything.
      throw new InternalServerErrorException('the realtime stream was opened without a scope');
    }
    const reconnect = isReconnectRequest(req);

    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next(
        frameOf(
          this.realtime.connectedEvent({
            reconnect,
            tenantId: scope.tenantId,
            storeId: scope.storeId ?? null,
          }),
        ),
      );

      const detach = this.realtime.subscribe((event) => {
        if (realtimeEventVisibleTo(event, scope)) {
          subscriber.next(frameOf(event));
        }
      });

      const keepalive = setInterval(() => {
        subscriber.next(frameOf(this.realtime.pingEvent()));
      }, REALTIME_KEEPALIVE_MS);
      // A held-open response is exactly what a Node process is not supposed to
      // exit while holding, so the keepalive must not be the reason it stays up.
      keepalive.unref?.();

      return () => {
        detach();
        clearInterval(keepalive);
      };
    });
  }
}

/**
 * Whether the caller is re-attaching after a break.
 *
 * Informational only. A client re-reads REST state on *every* connection,
 * including the first, so the flag can be lost, ignored or wrong without costing
 * any data — it exists so the workspace can tell the operator "连接已恢复"
 * instead of silently repainting.
 *
 * @param req - The incoming request.
 * @returns `true` when the caller declared this a re-connection.
 */
function isReconnectRequest(req: Request): boolean {
  const raw = req.query['reconnect'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'true' || value === '1';
}

/**
 * Render one frame as an SSE message.
 *
 * The SSE `event` name repeats the frame's own type so a client can route on the
 * wire field without parsing, and the payload is the whole envelope — the five
 * documented fields travel together, so no consumer has to merge two objects.
 *
 * @param event - The frame to send.
 * @returns The message to write.
 */
function frameOf(event: RealtimeEvent): MessageEvent {
  return { id: event.event_id, type: event.event_type, data: event };
}

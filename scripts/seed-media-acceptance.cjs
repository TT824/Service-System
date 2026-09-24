'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Seed one conversation that makes block 3b visible in the console.
 *
 * The interface suite deliberately never streams a stored image, because that
 * would mean putting an object into a real MinIO bucket from a test. This script
 * is the other half of that gap: it runs against the *local stack* — the real
 * PostgreSQL, the real MinIO and the real `MessageMediaService` — and leaves a
 * conversation behind whose transcript an operator can open and look at.
 *
 * What is real here:
 *
 * - `ingestInbound` writes the message rows, exactly as the callback path does.
 * - `MessageMediaService.capture` decides, fetches, writes the object through
 *   `MinioMediaStorage` and records the three media columns.
 *
 * What is not: the provider transport. `fetchMedia` is a stub handing back bytes
 * this script minted, because the Mock WeCom transport carries no media at all
 * (`parseInboundMessage` never sets it, so a Mock callback can never reach
 * `captureMedia`) and the real transport would need credentials and a network.
 * That boundary is the one the Mock transport already stands for.
 *
 * Three messages, because three renderings are what a transcript has to get
 * right, and only one of them is the happy path:
 *
 * 1. an image whose bytes are kept → `<img>` served under a signed URL;
 * 2. an image too large to keep → the refusal path, rendered as 图片未取回;
 * 3. a voice note, which block 3 stores as `text` + `[语音消息]` → a placeholder.
 *
 * Run it with the local stack up (docker compose), the same prerequisites the
 * API has:
 *
 *   node scripts/seed-media-acceptance.cjs
 */

const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

process.env.DOTENV_CONFIG_PATH = path.join(__dirname, '..', '.env');
require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({
  path: process.env.DOTENV_CONFIG_PATH,
});
require(path.join(__dirname, '..', 'node_modules', 'reflect-metadata'));

const { NestFactory } = require('@nestjs/core');
const { parseAppConfig } = require('@kefu/core');
const { AppModule } = require('../apps/api/dist/app.module');
const { PLATFORM_REPOSITORY } = require('../apps/api/dist/platform/platform-repository');
const { MessageMediaService } = require('../apps/api/dist/media/media.service');

/** Tenant, store and customer the acceptance conversation belongs to. */
const TENANT_ID = 'tenant-acme';
const STORE_ID = 'store-acme-flagship';
const CUSTOMER_ID = 'visual-acceptance-customer';
const THREAD_ID = 'visual-acceptance-thread';

/** Everything this run writes is stamped, so a rerun reads as a fresh arrival. */
const RUN = String(Date.now());

// ---------------------------------------------------------------------------
// A real PNG, minted here
// ---------------------------------------------------------------------------

/** CRC-32 table for the PNG chunk checksums. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 of one buffer, as every PNG chunk carries.
 *
 * @param {Buffer} buffer - Chunk type plus data.
 * @returns {number} The checksum.
 */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build one PNG chunk.
 *
 * @param {string} type - Four-character chunk type.
 * @param {Buffer} data - Chunk payload.
 * @returns {Buffer} The framed chunk.
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encode an RGB image as a PNG.
 *
 * A picture rather than a solid block on purpose: a broken `<img>` and a
 * correctly served one look identical when the bytes are one flat colour, and
 * the point of this file is to be able to tell them apart by looking.
 *
 * @param {number} width - Image width in pixels.
 * @param {number} height - Image height in pixels.
 * @returns {Buffer} A complete PNG.
 */
function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      // A diagonal checker over a two-colour gradient: obvious at a glance even
      // when the screenshot is scaled down.
      const checker = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
      const inside = Math.hypot(u - 0.5, v - 0.5) < 0.34;
      const base = checker
        ? [Math.round(40 + 180 * u), Math.round(90 + 120 * (1 - v)), 200]
        : [250, Math.round(230 - 120 * v), Math.round(120 + 100 * u)];
      const rgb = inside ? [255, 255, 255] : base;
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The image the happy path keeps. */
const ACCEPTANCE_PNG = png(320, 220);

/** A body past the platform's 2 MB ceiling, for the refusal path. */
const OVERSIZE_BYTES = Buffer.alloc(3 * 1024 * 1024, 0x7a);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Ingest one message and report what the platform did with it.
 *
 * @param {object} deps - The platform repository and the media service.
 * @param {object} input - What to ingest, and how its media should behave.
 * @returns {Promise<object>} The row, the captured outcome and the media URL.
 */
async function ingestAndCapture(deps, input) {
  const ingested = await deps.platform.ingestInbound({
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    channel: 'wecom',
    externalCustomerId: CUSTOMER_ID,
    externalConversationId: THREAD_ID,
    externalMessageId: input.externalMessageId,
    messageType: input.messageType,
    content: input.content,
    dedupKey: `acceptance:${input.externalMessageId}`,
    now: new Date(),
  });

  const outcome =
    input.media === null
      ? null
      : await deps.media.capture({
          tenantId: TENANT_ID,
          messageId: ingested.message.id,
          messageType: input.messageType,
          media: input.media,
          // The one fake: the provider's own download. Everything downstream of
          // it — the size rule, the object store, the three columns — is the
          // production code path.
          channel: {
            fetchMedia: async () => ({ ok: true, value: input.stub }),
          },
        });

  return { ingested, outcome };
}

async function main() {
  const parsed = parseAppConfig(process.env);
  if (parsed._tag !== 'ok') {
    throw new Error(`configuration did not parse: ${parsed.error.message}`);
  }
  const app = await NestFactory.createApplicationContext(AppModule.register(parsed.config), {
    logger: ['error', 'warn'],
  });
  try {
    const platform = app.get(PLATFORM_REPOSITORY);
    const media = app.get(MessageMediaService);

    const kept = await ingestAndCapture(
      { platform, media },
      {
        externalMessageId: `acceptance-image-kept-${RUN}`,
        messageType: 'image',
        content: '[图片消息]',
        media: { mediaId: `acceptance-media-kept-${RUN}`, mimeType: 'image/png' },
        stub: { mimeType: 'image/png', bytes: ACCEPTANCE_PNG },
      },
    );

    const refused = await ingestAndCapture(
      { platform, media },
      {
        externalMessageId: `acceptance-image-refused-${RUN}`,
        messageType: 'image',
        content: '[图片消息]',
        media: { mediaId: `acceptance-media-refused-${RUN}`, mimeType: 'image/png' },
        stub: { mimeType: 'image/png', bytes: OVERSIZE_BYTES },
      },
    );

    const voice = await ingestAndCapture(
      { platform, media },
      {
        externalMessageId: `acceptance-voice-${RUN}`,
        messageType: 'text',
        content: '[语音消息]',
        media: null,
      },
    );

    console.log(
      JSON.stringify(
        {
          conversationId: kept.ingested.conversation.id,
          run: RUN,
          messages: [
            {
              role: 'kept image',
              id: kept.ingested.message.id,
              created: kept.ingested.created,
              outcome: kept.outcome,
              sha256: createHash('sha256').update(ACCEPTANCE_PNG).digest('hex').slice(0, 16),
              pngBytes: ACCEPTANCE_PNG.length,
            },
            {
              role: 'refused image (3 MB)',
              id: refused.ingested.message.id,
              outcome: refused.outcome,
            },
            { role: 'voice placeholder', id: voice.ingested.message.id },
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`seed-media-acceptance: ${error.message}`);
  if (process.env.DEBUG) console.error(error);
  process.exitCode = 1;
});

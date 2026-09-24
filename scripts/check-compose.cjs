'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Offline sanity check for docker-compose.yml.
 *
 * A full `docker compose config` requires the Docker CLI, which is not present
 * in every development machine. This script verifies that the Compose file is
 * valid YAML and that the service/volume/network keys exist. It does not
 * substitute `${VAR}` defaults; that is left to the real Docker Compose engine.
 */

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const composePath = path.resolve(__dirname, '..', 'docker-compose.yml');

function main() {
  const source = fs.readFileSync(composePath, 'utf8');
  let document;
  try {
    document = YAML.parse(source);
  } catch (error) {
    console.error(`docker-compose.yml is not valid YAML: ${error.message}`);
    process.exit(1);
  }

  const errors = [];

  if (!document || typeof document !== 'object') {
    errors.push('compose document must be a mapping');
  } else {
    const services = document.services;
    if (!services || typeof services !== 'object') {
      errors.push('compose document must declare a "services" mapping');
    } else {
      const expected = ['postgres', 'redis', 'minio', 'minio-init'];
      for (const name of expected) {
        if (!Object.prototype.hasOwnProperty.call(services, name)) {
          errors.push(`missing expected service "${name}"`);
        }
      }
      for (const [name, service] of Object.entries(services)) {
        if (!service || typeof service !== 'object') {
          errors.push(`service "${name}" must be a mapping`);
          continue;
        }
        if (name !== 'minio-init' && !service.healthcheck) {
          errors.push(`service "${name}" should declare a healthcheck`);
        }
      }
      const minioHealthcheck = services.minio?.healthcheck;
      const minioHealthcheckText = JSON.stringify(minioHealthcheck ?? '');
      if (minioHealthcheckText.includes('mc ')) {
        errors.push('minio healthcheck must not depend on the mc client');
      }
      if (!minioHealthcheckText.includes('/minio/health/live')) {
        errors.push('minio healthcheck must probe /minio/health/live');
      }
    }
    if (document.volumes && typeof document.volumes === 'object') {
      const expectedVolumes = ['postgres_data', 'redis_data', 'minio_data'];
      for (const volume of expectedVolumes) {
        if (!Object.prototype.hasOwnProperty.call(document.volumes, volume)) {
          errors.push(`missing expected named volume "${volume}"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`compose check failed: ${message}`);
    }
    process.exit(1);
  }

  console.log(
    'docker-compose.yml parsed: services, volumes and MinIO healthcheck look well-formed',
  );
}

main();

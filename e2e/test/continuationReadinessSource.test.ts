import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import { FixtureRefusal } from '../src/continuation/fixture.js';
import {
  DockerReadinessObservationSource,
  type RuntimeReadinessBindings,
} from '../src/continuation/readinessSource.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const TREE_DIGEST = 'b'.repeat(64);
const STATE_DIGEST = 'c'.repeat(64);
const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const UPLOADER_ID = 'manager-profile-a';

interface Call {
  file: string;
  args: readonly string[];
}

class FakeCommand implements BoundedCommand {
  readonly calls: Call[] = [];

  constructor(private readonly answer: (call: Call) => CommandResult) {}

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    const call = { file, args };
    this.calls.push(call);
    return this.answer(call);
  }
}

function candidateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'continuation-readiness-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const ready = true;\n');
  return root;
}

function activeArtifact(root: string): string {
  const path = join(root, 'active-artifact.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      generation: 7,
      slot: { role: 'admin', id: 'default' },
      artifact: {
        treeDigest: TREE_DIGEST,
        images: [{ service: 'admin-api', imageId: IMAGE_ID }],
      },
    }),
  );
  return path;
}

function bindings(root: string): RuntimeReadinessBindings {
  return {
    probeContainerId: 'probe-id',
    postgresContainerId: 'postgres-id',
    allowedHttpOrigins: new Set(['http://blockchain:8545', 'http://admin-api:9877']),
    containers: new Map([
      ['admin-api', { id: 'admin-id', name: 'guarded-admin-api', configuredImage: IMAGE_ID }],
      ['uploader', { id: 'uploader-id', name: 'guarded-uploader', configuredImage: IMAGE_ID }],
    ]),
    guardSlots: new Map([
      ['admin', 'default'],
      ['uploader', UPLOADER_ID],
    ]),
    candidates: new Map([
      ['admin', { role: 'admin', root, commit: 'd'.repeat(40) }],
      ['uploader', { role: 'stack', root, commit: 'e'.repeat(40) }],
    ]),
  };
}

function inspectBody(path: string, id = 'admin-id'): string {
  return JSON.stringify({
    id,
    name: '/guarded-admin-api',
    imageId: IMAGE_ID,
    state: 'running',
    health: 'healthy',
    labels: {
      'org.solarpunk.srs-continuation.fixture': FIXTURE_ID,
      'org.solarpunk.srs-continuation.managed': 'true',
    },
    mounts: [
      {
        Type: 'bind',
        Source: path,
        Destination: '/run/streaming-release/active-artifact.json',
        RW: false,
      },
    ],
  });
}

function databaseAnswer(query: string): string {
  if (query.includes('release_guard_receipts')) {
    return JSON.stringify({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      generation: '7',
      stateDigest: STATE_DIGEST,
      role: 'uploader',
      slotId: UPLOADER_ID,
      minimumSrsLifecycle: 1,
      treeDigest: TREE_DIGEST,
      images: [{ service: 'stream-uploader', imageId: IMAGE_ID }],
    });
  }
  return JSON.stringify({
    uploaderId: UPLOADER_ID,
    lifecycleVersion: 1,
    profiles: [
      {
        renditions: [
          { avgBandwidth: 2_500_000, bandwidth: 2_800_000, height: 720, name: '720p', width: 1280 },
          { width: 640, name: '360p', bandwidth: 800_000, avgBandwidth: 700_000, height: 360 },
        ],
        mediaType: 'video',
      },
      { renditions: [], mediaType: 'audio' },
    ],
    receivedAt: '2026-09-21T00:00:00.000Z',
    freshUntil: '2026-09-21T00:00:30.000Z',
    serverNow: '2026-09-21T00:00:10.000Z',
  });
}

describe('DockerReadinessObservationSource', () => {
  it('reads exact journal container identity and the immutable admin artifact mount', async () => {
    const root = candidateRoot();
    const artifact = activeArtifact(root);
    const command = new FakeCommand(() => ({ stdout: inspectBody(artifact), stderr: '' }));
    const source = new DockerReadinessObservationSource(command, bindings(root), {
      async run() {
        return new Uint8Array();
      },
    });

    const observed = await source.inspectContainer('admin-api');

    assert.equal(observed.name, 'guarded-admin-api');
    assert.equal(observed.expectedName, 'guarded-admin-api');
    assert.equal(observed.configuredImage, IMAGE_ID);
    assert.equal(observed.activeArtifact?.generation, 7);
    assert.deepEqual(command.calls[0]?.args.slice(0, 3), ['container', 'inspect', '--format']);
  });

  it('refuses a Docker identity that differs from the journal binding', async () => {
    const root = candidateRoot();
    const artifact = activeArtifact(root);
    const command = new FakeCommand(() => ({ stdout: inspectBody(artifact, 'different-id'), stderr: '' }));
    const source = new DockerReadinessObservationSource(command, bindings(root), {
      async run() {
        return new Uint8Array();
      },
    });

    await assert.rejects(source.inspectContainer('admin-api'), FixtureRefusal);
  });

  it('allows only explicitly bound internal HTTP origins and bounds the response', async () => {
    const root = candidateRoot();
    const command = new FakeCommand(() => ({
      stdout: JSON.stringify({ status: 200, body: Buffer.from('{"status":"ok"}').toString('base64') }),
      stderr: '',
    }));
    const source = new DockerReadinessObservationSource(command, bindings(root), {
      async run() {
        return new Uint8Array();
      },
    });

    const response = await source.request({
      url: 'http://admin-api:9877/health',
      method: 'GET',
      headers: { accept: 'application/json' },
      maxResponseBytes: 1024,
    });
    assert.equal(Buffer.from(response.body).toString('utf8'), '{"status":"ok"}');
    await assert.rejects(
      source.request({
        url: 'http://example.com/health',
        method: 'GET',
        headers: {},
        maxResponseBytes: 1024,
      }),
      /not an allowed internal fixture endpoint/,
    );
    assert.equal(command.calls.length, 1);
  });

  it('reads the exact uploader slot receipt instead of inferring identity from a container name', async () => {
    const root = candidateRoot();
    const command = new FakeCommand((call) => {
      const query = call.args.at(-1) ?? '';
      assert.match(query, new RegExp(`slot_id = '${UPLOADER_ID}'`));
      return { stdout: databaseAnswer(query), stderr: '' };
    });
    const source = new DockerReadinessObservationSource(command, bindings(root), {
      async run() {
        return new Uint8Array();
      },
    });

    const receipt = await source.inspectGuard('uploader');

    assert.deepEqual(receipt.slot, { role: 'uploader', id: UPLOADER_ID });
    assert.match(receipt.candidate.treeDigest, /^[0-9a-f]{64}$/);
  });

  it('derives profile digests from the shared cross-service vectors after JSONB reordering', async () => {
    const root = candidateRoot();
    const command = new FakeCommand((call) => ({ stdout: databaseAnswer(call.args.at(-1) ?? ''), stderr: '' }));
    const source = new DockerReadinessObservationSource(command, bindings(root), {
      async run() {
        return new Uint8Array();
      },
    });

    const capability = await source.readUploaderCapability(UPLOADER_ID);

    assert.deepEqual(capability.profileDigests, [
      {
        mediaType: 'video',
        digest: ['b5f18ec2', 'be5380fb', '5014b079', '5cda418a', '6df8e9fb', '3d8842e0', 'c0ad898e', '9ffbab72'].join(
          '',
        ),
      },
      {
        mediaType: 'audio',
        digest: ['3a48ea6b', '29b48ede', '10d8fb96', '6b6787c9', '6f69ac8f', '6afd2894', 'e692652f', '90ed15a4'].join(
          '',
        ),
      },
    ]);
    assert.equal(capability.serverNow, '2026-09-21T00:00:10.000Z');
  });
});

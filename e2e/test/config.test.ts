import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  containerName,
  DEFAULT_PROFILE,
  engineEnvPath,
  type EngineName,
  loadConfig,
  rootEnvPath,
} from '../src/config.js';
import { OME_PORT_DEFAULTS, PORT_DEFAULTS } from '../src/ports.js';

/**
 * `loadConfig` reproduces the decision `deploy.sh` makes about where a deployment lives. These tests
 * point it at fixture roots rather than the repository's own `.env`, so what they assert is the
 * rule and not whatever the machine running them happens to have configured.
 */

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly root?: string;
  readonly engines?: Partial<Record<EngineName, string>>;
  readonly profiles?: Readonly<Record<string, string>>;
}

/** A stand-in repository root holding the env files a deploy would have written. */
function fixtureRoot({ root, engines = {}, profiles = {} }: Fixture = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-cfg-'));
  roots.push(dir);
  if (root !== undefined) {
    writeFileSync(join(dir, '.env'), root);
  }
  for (const [profile, text] of Object.entries(profiles)) {
    writeFileSync(join(dir, `.env.${profile}`), text);
  }
  for (const [engine, text] of Object.entries(engines)) {
    mkdirSync(join(dir, 'engines', engine), { recursive: true });
    writeFileSync(join(dir, 'engines', engine, '.env'), text as string);
  }
  return dir;
}

describe('env file selection follows the profile', () => {
  // `_lib.sh` uses the bare `.env` for the default profile and `.env.<profile>` for any other, and
  // `engine_env_file` picks exactly one file rather than layering a profile copy over a base.
  it('uses .env and engines/<engine>/.env for the default profile', () => {
    assert.equal(rootEnvPath(DEFAULT_PROFILE, '/repo'), join('/repo', '.env'));
    assert.equal(engineEnvPath('srs', DEFAULT_PROFILE, '/repo'), join('/repo', 'engines', 'srs', '.env'));
  });

  it('uses .env.<profile> and engines/<engine>/.env.<profile> for a named profile', () => {
    assert.equal(rootEnvPath('streamer1', '/repo'), join('/repo', '.env.streamer1'));
    assert.equal(engineEnvPath('ome', 'streamer1', '/repo'), join('/repo', 'engines', 'ome', '.env.streamer1'));
  });
});

/**
 * The ABR ladder, read off the deployment rather than chosen by the suite.
 *
 * An ABR suite run against a single-rendition stack is not applicable, not broken, so it needs to be
 * able to tell the difference. Same reasoning as `publishKeySecret`: the engine either produces four
 * rungs or one, and this suite does not get a vote.
 */
describe('the ABR ladder the deployment configured', () => {
  it('is off when nothing says otherwise, which is the shipped default', () => {
    const cfg = loadConfig({ env: {}, rootDir: fixtureRoot() });

    assert.equal(cfg.abrEnabled, false);
  });

  it('is on for the two spellings the uploader itself accepts', () => {
    for (const value of ['true', '1']) {
      const rootDir = fixtureRoot({ root: `ABR_ENABLED=${value}\n` });
      assert.equal(loadConfig({ env: {}, rootDir }).abrEnabled, true, `ABR_ENABLED=${value}`);
    }
  });

  /**
   * Not a truthiness check. The uploader refuses to start on anything outside that pair, so reading
   * a typo as `false` here would have this suite disagree with the service about what it is testing.
   */
  it('is off for a value the uploader would refuse, rather than guessed at', () => {
    for (const value of ['yes', 'TRUE', 'on', '2']) {
      const rootDir = fixtureRoot({ root: `ABR_ENABLED=${value}\n` });
      assert.equal(loadConfig({ env: {}, rootDir }).abrEnabled, false, `ABR_ENABLED=${value}`);
    }
  });

  it('names the rungs in ladder order, which is the order a master lists them', () => {
    const rootDir = fixtureRoot({
      root: 'ABR_ENABLED=true\nABR_LADDER=360p:640:360:700 480p:854:480:1200 720p:1280:720:2800\n',
    });

    assert.deepEqual(loadConfig({ env: {}, rootDir }).abrRungs, ['360p', '480p', '720p']);
  });

  it('reads the ladder out of the engine env too, since that is where the sample documents it', () => {
    const rootDir = fixtureRoot({
      root: 'ABR_ENABLED=true\n',
      engines: { srs: 'ABR_LADDER=1080p:1920:1080:5000 720p:1280:720:2800\n' },
    });

    assert.deepEqual(loadConfig({ env: {}, rootDir }).abrRungs, ['1080p', '720p']);
  });

  /**
   * An unset `ABR_LADDER` falls back to the same default the uploader and the SRS entrypoint use, so
   * the suite reads the four rungs a documented install runs rather than an empty list. `.env.sample`
   * ships the variable blank for exactly this reason, and a run against the shipped config would find
   * no rungs and skip itself if this fell back to nothing.
   */
  it('falls back to the shared default ladder when nothing overrides it', () => {
    const rootDir = fixtureRoot({ root: 'ABR_ENABLED=true\n' });

    assert.deepEqual(loadConfig({ env: {}, rootDir }).abrRungs, ['1080p', '720p', '480p', '360p']);
  });

  it('ignores the geometry, so a reformatted entry does not become a rung name', () => {
    const rootDir = fixtureRoot({ root: 'ABR_LADDER=  720p:1280:720:2800   1080p:1920:1080:5000  \n' });

    assert.deepEqual(loadConfig({ env: {}, rootDir }).abrRungs, ['720p', '1080p']);
  });
});

describe('engine selection', () => {
  it('defaults to srs when nothing says otherwise', () => {
    assert.equal(loadConfig({ env: {}, rootDir: fixtureRoot() }).engine, 'srs');
  });

  // The deployment's own ENGINE key is the honest default: it is what the stack is actually running.
  it('takes ENGINE from the root env file', () => {
    assert.equal(loadConfig({ env: {}, rootDir: fixtureRoot({ root: 'ENGINE=ome\n' }) }).engine, 'ome');
  });

  it('lets E2E_ENGINE override the deployment ENGINE', () => {
    const rootDir = fixtureRoot({ root: 'ENGINE=ome\n' });
    assert.equal(loadConfig({ env: { E2E_ENGINE: 'srs' }, rootDir }).engine, 'srs');
  });

  it('refuses an engine that does not exist', () => {
    assert.throws(() => loadConfig({ env: { E2E_ENGINE: 'nginx' }, rootDir: fixtureRoot() }), /E2E_ENGINE/);
  });

  // The engine decides which engine env file is read, so it has to be resolved from the root env
  // before that file is opened. Reading them in the other order finds SRS's ports for an OME deploy.
  it('reads the engine env file of the engine the root env selected', () => {
    const rootDir = fixtureRoot({
      root: 'ENGINE=ome\n',
      engines: { ome: 'OME_SRT_PORT=12345\n', srs: 'OME_SRT_PORT=999\n' },
    });
    assert.equal(loadConfig({ env: {}, rootDir }).omeSrtPort, 12345);
  });
});

describe('port resolution through a profile', () => {
  it('takes the deployment env values at the default slot', () => {
    const rootDir = fixtureRoot({ root: 'API_PORT=3000\nBEE_GATEWAY_API_PORT=1733\n' });
    const cfg = loadConfig({ env: {}, rootDir });
    assert.equal(cfg.ports.uploaderApi, 3000);
    assert.equal(cfg.ports.beeGatewayApi, 1733);
  });

  it('ignores those values once a port slot is given', () => {
    const rootDir = fixtureRoot({ root: 'API_PORT=3000\n' });
    const cfg = loadConfig({ env: { E2E_PORT_SLOT: '3' }, rootDir });
    assert.equal(cfg.ports.uploaderApi, PORT_DEFAULTS.API_PORT.base + 30);
    assert.equal(cfg.portSlot, 3);
  });

  it('reads a named profile from its own env file', () => {
    const rootDir = fixtureRoot({ root: 'API_PORT=3000\n', profiles: { streamer1: 'API_PORT=4000\n' } });
    const cfg = loadConfig({ env: { E2E_PROFILE: 'streamer1' }, rootDir });
    assert.equal(cfg.ports.uploaderApi, 4000, 'the profile env must win over the default one');
  });

  it('lets an exported variable beat both files, as the shell does', () => {
    const rootDir = fixtureRoot({ root: 'API_PORT=3000\n' });
    assert.equal(loadConfig({ env: { API_PORT: '9999' }, rootDir }).ports.uploaderApi, 9999);
  });
});

describe('OME ports come from the engine env, not the slot', () => {
  it('defaults to the sample values when no engine env exists', () => {
    const cfg = loadConfig({ env: { E2E_ENGINE: 'ome' }, rootDir: fixtureRoot() });
    assert.equal(cfg.omeSrtPort, OME_PORT_DEFAULTS.OME_SRT_PORT);
    assert.equal(cfg.omeHlsPort, OME_PORT_DEFAULTS.OME_HLS_PORT);
  });

  // The mistake this guards: deriving OME's SRT port from the port slot the way the profile ports
  // are derived. `apply_port_slot` leaves these alone, so a slot deploy still binds OME to the port
  // in its engine env, and a publisher aimed at a slot-shifted port reaches nothing.
  it('does not shift with the port slot', () => {
    const rootDir = fixtureRoot({ engines: { ome: 'OME_SRT_PORT=10081\n' } });
    const cfg = loadConfig({ env: { E2E_ENGINE: 'ome', E2E_PORT_SLOT: '5' }, rootDir });
    assert.equal(cfg.omeSrtPort, 10081, 'the OME SRT port must not follow the slot');
    assert.equal(cfg.ports.srt, PORT_DEFAULTS.SRS_SRT_PORT.base + 50, 'while the profile SRT port does');
  });

  it('accepts an explicit override for a standalone OME', () => {
    const rootDir = fixtureRoot({ engines: { ome: 'OME_SRT_PORT=10081\n' } });
    const cfg = loadConfig({ env: { E2E_ENGINE: 'ome', E2E_OME_SRT_PORT: '20080' }, rootDir });
    assert.equal(cfg.omeSrtPort, 20080);
  });
});

describe('container naming', () => {
  it('prefixes with the compose project, which is the profile', () => {
    const cfg = loadConfig({
      env: { E2E_PROFILE: 'streamer1' },
      rootDir: fixtureRoot({ profiles: { streamer1: '' } }),
    });
    assert.equal(containerName(cfg, 'stream-uploader'), 'streamer1-stream-uploader-1');
    assert.equal(containerName(cfg, 'bee-uploader'), 'streamer1-bee-uploader-1');
  });

  it('uses the default project when no profile was given', () => {
    const cfg = loadConfig({ env: {}, rootDir: fixtureRoot() });
    assert.equal(containerName(cfg, 'srs'), 'default-srs-1');
    assert.equal(cfg.omeContainer, 'default-ome-1');
  });
});

describe('refusals', () => {
  const rootDir = () => fixtureRoot();

  it('refuses deploy mode, which is not implemented', () => {
    assert.throws(() => loadConfig({ env: { E2E_MODE: 'deploy' }, rootDir: rootDir() }), /not implemented/);
  });

  it('refuses a mode that is neither', () => {
    assert.throws(() => loadConfig({ env: { E2E_MODE: 'attatch' }, rootDir: rootDir() }), /E2E_MODE/);
  });

  /**
   * An ssh target is an argv element, so the risk is option confusion rather than injection: ssh
   * reads a leading `-` as a flag of its own. This is the same shape as the leading-dash data dir
   * that reached `mkdir` as an option and died naming neither the variable nor the value.
   */
  it('refuses an ssh target that ssh would read as an option', () => {
    assert.throws(
      () => loadConfig({ env: { E2E_SSH_TARGET: '-oProxyCommand=id' }, rootDir: rootDir() }),
      /E2E_SSH_TARGET/,
    );
  });

  it('accepts the ordinary ssh target spellings', () => {
    for (const target of ['manager-host', 'deploy@10.0.0.4', 'streamer.example.com', 'host_1']) {
      assert.equal(loadConfig({ env: { E2E_SSH_TARGET: target }, rootDir: rootDir() }).sshTarget, target);
    }
  });

  it('refuses a profile that is not a docker-safe project name', () => {
    assert.throws(() => loadConfig({ env: { E2E_PROFILE: 'my profile' }, rootDir: rootDir() }), /E2E_PROFILE/);
    assert.throws(() => loadConfig({ env: { E2E_PROFILE: '-p' }, rootDir: rootDir() }), /E2E_PROFILE/);
  });

  it('refuses a stream path that is not <app>/<name>', () => {
    for (const path of ['stream', 'live/stream/extra', 'live/', '/stream']) {
      assert.throws(() => loadConfig({ env: { E2E_STREAM_PATH: path }, rootDir: rootDir() }), /E2E_STREAM_PATH/);
    }
  });

  /**
   * The one guard with no refusal test, and the only one whose value reaches a remote shell as
   * genuine command interpolation: it flows to `engine.ts`, then `engine-restart` calls
   * `host.restart(mediaContainer)`, which builds `docker restart ${container}` and hands the whole
   * string to the far side's login shell. `E2E_SSH_TARGET` is an argv element, so its risk is
   * option confusion; this one is the injection.
   */
  it('refuses an ome container name that would reach the remote shell as syntax', () => {
    for (const name of ['ome; touch /tmp/pwned', 'ome $(id)', 'ome`id`', 'ome|id', 'ome name', '-rf']) {
      assert.throws(
        () => loadConfig({ env: { E2E_OME_CONTAINER: name }, rootDir: rootDir() }),
        /E2E_OME_CONTAINER/,
        `${JSON.stringify(name)} was accepted as a container name`,
      );
    }
  });

  it('accepts an ordinary ome container name', () => {
    const cfg = loadConfig({ env: { E2E_OME_CONTAINER: 'ome' }, rootDir: rootDir() });
    assert.equal(cfg.omeContainer, 'ome');
  });

  it('refuses a public host that is not an address', () => {
    assert.throws(
      () => loadConfig({ env: { E2E_PUBLIC_HOST: 'http://example.com' }, rootDir: rootDir() }),
      /E2E_PUBLIC_HOST/,
    );
  });

  it('accepts an IPv6 public host in brackets, as a URL authority needs', () => {
    assert.equal(
      loadConfig({ env: { E2E_PUBLIC_HOST: '[2001:db8::1]' }, rootDir: rootDir() }).publicHost,
      '[2001:db8::1]',
    );
  });
});

describe('the two knobs an env file may not set', () => {
  /**
   * `E2E_PROFILE` chooses which env file is read, so honouring it from inside one is circular, and
   * the port slot rides with it because the pair names one deployment.
   *
   * Ignoring them silently was the defect. `E2E_SSH_TARGET` and `E2E_PUBLIC_HOST` ARE read from
   * these files, so an operator putting all four in `.env` got a suite that reached the right host
   * and then targeted the wrong deployment on it: smoke passed end to end, and `e2e:run` went on to
   * stop and kill whatever was running under the default profile while the one they named was never
   * touched.
   */
  for (const key of ['E2E_PROFILE', 'E2E_PORT_SLOT']) {
    it(`refuses ${key} in the root env file rather than ignoring it`, () => {
      const rootDir = fixtureRoot({ root: `${key}=whatever\n` });
      assert.throws(() => loadConfig({ env: {}, rootDir }), new RegExp(`${key} cannot be set in`));
    });

    it(`refuses ${key} in the engine env file too`, () => {
      const rootDir = fixtureRoot({ engines: { srs: `${key}=whatever\n` } });
      assert.throws(() => loadConfig({ env: {}, rootDir }), new RegExp(`${key} cannot be set in`));
    });
  }

  it('names the file and how to pass it instead', () => {
    const rootDir = fixtureRoot({ root: 'E2E_PROFILE=streamer1\n' });
    assert.throws(
      () => loadConfig({ env: {}, rootDir }),
      (error: Error) => {
        assert.match(error.message, /\.env/, 'the message must name the file');
        assert.match(error.message, /pnpm e2e:smoke/, 'and how to pass it instead');
        return true;
      },
    );
  });

  // Still honoured from the environment, which is the supported way to name a deployment.
  it('honours both from the process environment', () => {
    const rootDir = fixtureRoot({ profiles: { streamer1: '' } });
    const cfg = loadConfig({ env: { E2E_PROFILE: 'streamer1', E2E_PORT_SLOT: '2' }, rootDir });
    assert.equal(cfg.profile, 'streamer1');
    assert.equal(cfg.portSlot, 2);
  });

  // The neighbours that ARE read from a file must keep working, or this guard has traded one
  // surprise for another.
  it('still reads the other E2E vars from the root env file', () => {
    const rootDir = fixtureRoot({ root: 'E2E_SSH_TARGET=streamhost\nE2E_PUBLIC_HOST=203.0.113.10\n' });
    const cfg = loadConfig({ env: {}, rootDir });
    assert.equal(cfg.sshTarget, 'streamhost');
    assert.equal(cfg.publicHost, '203.0.113.10');
  });
});

describe('stream path defaults per engine', () => {
  // OME rejects an app that is not `video` or `audio`, so the two engines cannot share one default.
  it('is live/stream for srs and video/stream for ome', () => {
    assert.equal(loadConfig({ env: {}, rootDir: fixtureRoot() }).streamPath, 'live/stream');
    assert.equal(loadConfig({ env: { E2E_ENGINE: 'ome' }, rootDir: fixtureRoot() }).streamPath, 'video/stream');
  });
});

describe('reported env files', () => {
  // Printed by the smoke test, because "which files did you read" is the first question when a
  // suite resolves a port nothing is listening on.
  it('names the root and engine files it resolved against', () => {
    const rootDir = fixtureRoot({ root: 'ENGINE=ome\n' });
    assert.deepEqual(loadConfig({ env: {}, rootDir }).envFiles, [
      join(rootDir, '.env'),
      join(rootDir, 'engines', 'ome', '.env'),
    ]);
  });
});

/**
 * What the run says about whether a real browser watched, read the same way the ABR declaration is.
 *
 * Kept beside `abrExpectation` rather than in the viewer suites, so a deployment declares itself once
 * in its own env file and the smoke test's env dump shows it. See `src/viewerCoverage.ts` for why an
 * undeclared run has to stop rather than skip.
 */
describe('whether the run expects a real viewer', () => {
  it('is undeclared when nothing says, which is what makes the gate refuse', () => {
    assert.equal(loadConfig({ env: {}, rootDir: fixtureRoot() }).viewerExpectation, 'undeclared');
  });

  it('reads a declared browser run out of the profile env, where a deployment states it once', () => {
    const rootDir = fixtureRoot({ root: 'E2E_EXPECT_BROWSER=true\n' });

    assert.equal(loadConfig({ env: {}, rootDir }).viewerExpectation, 'browser');
  });

  it('reads a declared browser-less run', () => {
    const rootDir = fixtureRoot({ root: 'E2E_EXPECT_BROWSER=false\n' });

    assert.equal(loadConfig({ env: {}, rootDir }).viewerExpectation, 'none');
  });

  /** A typo must not demote an operator who was declaring into one who never did. */
  it('refuses a spelling neither vocabulary knows', () => {
    const rootDir = fixtureRoot({ root: 'E2E_EXPECT_BROWSER=yes\n' });

    assert.throws(() => loadConfig({ env: {}, rootDir }), /E2E_EXPECT_BROWSER/);
  });
});

/**
 * How long a segment the run needs, read the same way the other two declarations are.
 *
 * The number differs between the two shipped profiles on purpose, because the two viewer types
 * measured opposite optima on 2026-08-16. See `src/segmentLength.ts` for the figures.
 */
describe('what segment length the run needs', () => {
  it('is undeclared when nothing says, which is what makes the gate refuse', () => {
    assert.equal(loadConfig({ env: {}, rootDir: fixtureRoot() }).segmentExpectation, 'undeclared');
  });

  it('reads the number out of the env, so a deployment can state it once', () => {
    const rootDir = fixtureRoot({ root: 'E2E_EXPECT_SEGMENT_S=2\n' });

    assert.equal(loadConfig({ env: {}, rootDir }).segmentExpectation, 2);
  });

  it('reads the word that waives the check, which is a declaration and not a gap', () => {
    const rootDir = fixtureRoot({ root: 'E2E_EXPECT_SEGMENT_S=any\n' });

    assert.equal(loadConfig({ env: {}, rootDir }).segmentExpectation, 'any');
  });

  it('refuses a value no arithmetic can use', () => {
    const rootDir = fixtureRoot({ root: 'E2E_EXPECT_SEGMENT_S=two\n' });

    assert.throws(() => loadConfig({ env: {}, rootDir }), /E2E_EXPECT_SEGMENT_S/);
  });
});

/**
 * The ladder as a browser reports it, which no suite could ask for before 2026-08-29.
 *
 * ⛔ The uploader logs rung NAMES and a browser reports RESOLUTIONS, so `abrRungs` cannot answer
 * "did this viewer get a quality we configured". That is the whole reason this field exists.
 */
describe('the ladder resolutions a viewer can be checked against', () => {
  it('spells them with the multiplication sign the client renders, not the letter x', () => {
    const rootDir = fixtureRoot({
      root: 'ABR_ENABLED=true\nABR_LADDER=1080p:1920:1080:5000 360p:640:360:700\n',
    });

    assert.deepEqual(loadConfig({ env: {}, rootDir }).abrLadderResolutions, ['1920×1080', '640×360']);
  });

  /** A malformed entry shrinks the expectation rather than inventing a resolution to demand. */
  it('drops an entry that is missing a dimension', () => {
    const rootDir = fixtureRoot({ root: 'ABR_ENABLED=true\nABR_LADDER=1080p:1920:1080:5000 broken:640\n' });

    assert.deepEqual(loadConfig({ env: {}, rootDir }).abrLadderResolutions, ['1920×1080']);
  });
});

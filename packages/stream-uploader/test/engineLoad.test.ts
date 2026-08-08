import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENGINE_NONE, loadEngines } from '../src/engines/load.js';
import { engineRegistry } from '../src/engines/registry.js';
import { EnginePlugin } from '../src/engines/types.js';

const plugin = (name: string): EnginePlugin => ({ name } as unknown as EnginePlugin);

/** A loader wired to a registry of two, recording what it built and in which order. */
function loaderUnderTest(): {
  deps: Parameters<typeof loadEngines>[1];
  built: string[];
  envLoaded: string[];
  warnings: string[];
} {
  const built: string[] = [];
  const envLoaded: string[] = [];
  const warnings: string[] = [];

  return {
    deps: {
      registry: {
        srs: () => {
          built.push('srs');
          return plugin('srs');
        },
        ome: () => {
          built.push('ome');
          return plugin('ome');
        },
      },
      loadEnv: (engine: string) => void envLoaded.push(engine),
      logger: { warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) } as never,
    },
    built,
    envLoaded,
    warnings,
  };
}

/**
 * Which engine the service runs, executed for the first time.
 *
 * It lived in `index.ts`, which calls `start()` at module scope, so 14 of that file's 62 surviving
 * mutants were here. Getting this wrong leaves the uploader up and healthy with nothing able to ingest
 * into it, which is a failure that looks exactly like a quiet day.
 */
describe('choosing the engines to run', () => {
  it('builds the engine it was named', () => {
    const { deps, built } = loaderUnderTest();

    const engines = loadEngines('srs', deps);

    assert.equal(engines.length, 1);
    assert.deepEqual(built, ['srs']);
  });

  it('builds only the one it was named, out of a registry of several', () => {
    const { deps, built } = loaderUnderTest();

    loadEngines('ome', deps);

    assert.deepEqual(built, ['ome']);
  });

  /**
   * ⭐ Order, and it is load-bearing. An engine reads its own settings out of the environment as it is
   * constructed, so an environment loaded afterwards produces a plugin holding the defaults, silently.
   */
  it('loads the engine environment before building anything with it', () => {
    const order: string[] = [];
    const engines = loadEngines('srs', {
      registry: {
        srs: () => {
          order.push('built');
          return plugin('srs');
        },
      },
      loadEnv: () => void order.push('env'),
      logger: { warn: () => {} } as never,
    });

    assert.equal(engines.length, 1);
    assert.deepEqual(order, ['env', 'built'], 'the engine was built against an environment not yet loaded');
  });

  it('loads the environment for the engine it was asked for', () => {
    const { deps, envLoaded } = loaderUnderTest();

    loadEngines('ome', deps);

    assert.deepEqual(envLoaded, ['ome']);
  });

  /**
   * ⛔ A misspelled engine leaves the service running with the generic API and nothing to ingest from.
   * The warning is the only difference between a puzzling silence and an obvious typo, so it must fire
   * for a name that is wrong and stay quiet for one that is deliberate.
   */
  it('warns about a name it does not recognise, and starts anyway', () => {
    const { deps, warnings, built } = loaderUnderTest();

    const engines = loadEngines('srsss', deps);

    assert.deepEqual(engines, []);
    assert.deepEqual(built, []);
    assert.match(warnings.join(' '), /srsss/, 'the warning did not say which name was rejected');
  });

  it('says nothing about the name that deliberately means no engine', () => {
    const { deps, warnings } = loaderUnderTest();

    assert.deepEqual(loadEngines(ENGINE_NONE, deps), []);
    assert.deepEqual(warnings, []);
  });

  /** The literal a deployment actually writes, so the constant cannot drift away from the config. */
  it('treats the literal "none" as that name, whatever the constant is called', () => {
    const { deps, warnings } = loaderUnderTest();

    assert.deepEqual(loadEngines('none', deps), []);
    assert.deepEqual(warnings, [], 'ENGINE=none in a deployment was reported as a misspelling');
  });

  it('says nothing when no engine was configured at all', () => {
    const { deps, warnings } = loaderUnderTest();

    assert.deepEqual(loadEngines('', deps), []);
    assert.deepEqual(warnings, [], 'an unset engine was reported as a misspelling');
  });

  it('does not load an environment for an engine it is not going to build', () => {
    const { deps, envLoaded } = loaderUnderTest();

    loadEngines('srsss', deps);

    assert.deepEqual(envLoaded, []);
  });

  /**
   * Against the **real** registry rather than the fixture. Every test above injects its own, so all of
   * them would keep passing if an engine were renamed out of the shipped one and no deployment could
   * start. The first version of this test looped over the fixture and asserted exactly nothing.
   */
  it('is backed by a registry holding the engines this service actually ships', () => {
    assert.deepEqual(Object.keys(engineRegistry).sort(), ['ome', 'srs']);
  });

  it('falls back to the shipped registry when no registry is injected', () => {
    const warnings: string[] = [];

    const engines = loadEngines('srsss', {
      loadEnv: () => {},
      logger: { warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) } as never,
    });

    assert.deepEqual(engines, []);
    assert.match(warnings.join(' '), /srsss/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerCrashHandlers, registerShutdownSignals, SHUTDOWN_SIGNALS } from '../src/libs/processSignals.js';

type Listener = (...args: never[]) => void;

/** Stands in for `process`, so a test can deliver a signal without the runner receiving one. */
class RecordingProcess {
  private readonly listeners = new Map<string, Listener[]>();

  public on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  public get registered(): string[] {
    return [...this.listeners.keys()];
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...args: unknown[]) => void)(...args);
    }
  }
}

const shutdownRecorder = () => {
  const signals: string[] = [];
  return {
    signals,
    lifecycle: {
      shutdown: async (signal: string) => {
        signals.push(signal);
      },
    },
  };
};

const crashRecorder = () => {
  const lines: { label: string; value: unknown }[] = [];
  return { lines, logger: { error: (label: string, value?: unknown) => void lines.push({ label, value }) } };
};

/**
 * Signal names are written out here rather than read from `SHUTDOWN_SIGNALS`, on purpose. Driving the
 * assertions from the same constant the code registers with makes the pair agree by construction, so
 * emptying the list or blanking a name passes either way and the test states nothing.
 */
describe('process signal handling', () => {
  it('shuts down on SIGTERM, which is what docker stop and Kubernetes send', () => {
    const events = new RecordingProcess();
    const { signals, lifecycle } = shutdownRecorder();

    registerShutdownSignals(lifecycle, events);
    events.emit('SIGTERM');

    assert.deepEqual(signals, ['SIGTERM'], 'SIGTERM did not reach the lifecycle, so a deploy would not drain');
  });

  it('shuts down on SIGINT', () => {
    const events = new RecordingProcess();
    const { signals, lifecycle } = shutdownRecorder();

    registerShutdownSignals(lifecycle, events);
    events.emit('SIGINT');

    assert.deepEqual(signals, ['SIGINT']);
  });

  it('tells the lifecycle which signal arrived, not merely that one did', () => {
    const events = new RecordingProcess();
    const { signals, lifecycle } = shutdownRecorder();

    registerShutdownSignals(lifecycle, events);
    events.emit('SIGINT');
    events.emit('SIGTERM');

    assert.deepEqual(signals, ['SIGINT', 'SIGTERM']);
  });

  it('registers those two signals and nothing else', () => {
    const events = new RecordingProcess();

    registerShutdownSignals(shutdownRecorder().lifecycle, events);

    assert.deepEqual(events.registered.sort(), ['SIGINT', 'SIGTERM']);
    assert.deepEqual(
      [...SHUTDOWN_SIGNALS].sort(),
      ['SIGINT', 'SIGTERM'],
      'the exported list drifted from what is registered',
    );
  });

  it('writes every line of an uncaught exception, not just the first', () => {
    const events = new RecordingProcess();
    const { lines, logger } = crashRecorder();

    registerCrashHandlers(logger, events);
    events.emit('uncaughtException', new Error('boom'));

    assert.equal(lines.length, 2, 'an Error carries a message line and a stack line');
    assert.deepEqual(lines[0], { label: 'Uncaught exception:', value: new Error('boom') });
    assert.match(String(lines[1].value), /boom/, 'the stack line is empty, so the crash log has no location in it');
  });

  it('writes the reason behind an unhandled rejection', () => {
    const events = new RecordingProcess();
    const { lines, logger } = crashRecorder();

    registerCrashHandlers(logger, events);
    events.emit('unhandledRejection', new Error('nope'));

    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { label: 'Unhandled rejection:', value: new Error('nope') });
    assert.match(String(lines[1].value), /nope/);
  });

  it('registers both crash events and nothing else', () => {
    const events = new RecordingProcess();

    registerCrashHandlers(crashRecorder().logger, events);

    assert.deepEqual(events.registered.sort(), ['uncaughtException', 'unhandledRejection']);
  });
});

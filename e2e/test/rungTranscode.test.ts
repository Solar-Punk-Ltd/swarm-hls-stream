import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  listProcessesCommand,
  requireRungName,
  resumeAllTranscodesCommand,
  rungOutputMarker,
  rungProcesses,
  SIGNAL_QUIET,
  SIGNAL_RESUME,
  signalCommand,
} from '../src/browser/rungTranscode.js';

/**
 * ⛔ A signal sent to the wrong process is INVISIBLE. Three healthy rungs and one quiet one looks the
 * same whichever one was silenced, and a run that silenced nothing looks like a ladder that survived
 * the fault perfectly. Everything here exists so that cannot happen quietly.
 */

/** `ps -eo pid,args` inside the SRS container while a four rung ladder is live. */
const PS_OUTPUT = [
  '    PID COMMAND',
  '      1 ./objs/srs -c conf/srs.conf',
  '    412 ./objs/ffmpeg/bin/ffmpeg -f flv -i rtmp://127.0.0.1:10002/live/demo -vcodec libx264 -s 1920x1080 -f flv rtmp://127.0.0.1:10002/live/demo_1080p?vhost=abr',
  '    418 ./objs/ffmpeg/bin/ffmpeg -f flv -i rtmp://127.0.0.1:10002/live/demo -vcodec libx264 -s 1280x720 -f flv rtmp://127.0.0.1:10002/live/demo_720p?vhost=abr',
  '    424 ./objs/ffmpeg/bin/ffmpeg -f flv -i rtmp://127.0.0.1:10002/live/demo -vcodec libx264 -s 854x480 -f flv rtmp://127.0.0.1:10002/live/demo_480p?vhost=abr',
  '    430 ./objs/ffmpeg/bin/ffmpeg -f flv -i rtmp://127.0.0.1:10002/live/demo -vcodec libx264 -s 640x360 -f flv rtmp://127.0.0.1:10002/live/demo_360p?vhost=abr',
].join('\n');

describe('finding the one transcode that produces a rung', () => {
  it('finds exactly the rung asked for, out of a live four rung ladder', () => {
    const found = rungProcesses(PS_OUTPUT, '720p');

    assert.equal(found.length, 1);
    assert.equal(found[0].pid, 418);
    assert.match(found[0].args, /1280x720/);
  });

  /**
   * ⛔ The marker carries the `?` that opens the vhost query, so a rung cannot match a longer name it
   * is a prefix of. Without it, silencing `360p` on a ladder carrying `360p` and `360px` would stop
   * whichever ffmpeg the process table happened to list first.
   */
  it('does not match a rung whose name it is only a prefix of', () => {
    const withLonger = `${PS_OUTPUT}\n    436 ffmpeg -f flv rtmp://127.0.0.1:10002/live/demo_360px?vhost=abr`;

    const found = rungProcesses(withLonger, '360p');

    assert.equal(found.length, 1);
    assert.equal(found[0].pid, 430);
  });

  /** ⛔ Every match, not the first. Two is a state the caller has to see rather than pick one out of. */
  it('returns every match, so a respawned or doubled transcode is visible', () => {
    const doubled = `${PS_OUTPUT}\n    512 ffmpeg -f flv rtmp://127.0.0.1:10002/live/other_720p?vhost=abr`;

    assert.equal(rungProcesses(doubled, '720p').length, 2);
  });

  /** No broadcast is live, so no transcode exists. Empty, never a guess. */
  it('finds nothing when the ladder is not running', () => {
    assert.deepEqual(rungProcesses('    PID COMMAND\n      1 ./objs/srs -c conf/srs.conf', '720p'), []);
  });

  it('carries the whole command line back, so the artifact can be checked against what was silenced', () => {
    assert.match(rungProcesses(PS_OUTPUT, '1080p')[0].args, /^\.\/objs\/ffmpeg\/bin\/ffmpeg .*1920x1080/);
  });
});

describe('the rung name, before it reaches a shell', () => {
  /**
   * ⛔ Stricter than a general name: no underscore. The uploader recovers a rung by splitting the
   * stream id on its LAST underscore, so a rung carrying one cannot be matched back, and the engine's
   * own require_rung_name applies the same rule.
   */
  it('refuses a name the engine would itself have refused', () => {
    assert.throws(() => requireRungName('720_p'), /not a rung name/);
    assert.throws(() => requireRungName('720p; rm -rf /'), /not a rung name/);
    assert.throws(() => requireRungName(''), /not a rung name/);
  });

  it('accepts the names the shipped ladder declares', () => {
    for (const name of ['1080p', '720p', '480p', '360p']) {
      assert.equal(requireRungName(name), name);
    }
  });

  it('builds a marker that pins the rung to its own output url', () => {
    assert.equal(rungOutputMarker('480p'), '_480p?vhost=');
  });
});

describe('the commands sent to the host', () => {
  it('reads the process table of the container it was given', () => {
    assert.equal(listProcessesCommand('latbench-srs-1'), "docker exec 'latbench-srs-1' ps -eo pid,args");
  });

  it('sends one signal to every pid it found', () => {
    assert.equal(
      signalCommand('latbench-srs-1', [418, 419], SIGNAL_QUIET),
      "docker exec 'latbench-srs-1' kill -STOP 418 419",
    );
    assert.equal(signalCommand('latbench-srs-1', [418], SIGNAL_RESUME), "docker exec 'latbench-srs-1' kill -CONT 418");
  });

  /**
   * ⛔ The failure this exists for. `kill -STOP` with no arguments succeeds at doing nothing, so a run
   * that matched no process would report a clean fault, watch a completely healthy ladder, and pass.
   */
  it('refuses to send a signal to nothing, which would report a fault that never landed', () => {
    assert.throws(() => signalCommand('latbench-srs-1', [], SIGNAL_QUIET), /never landed/);
  });

  it('refuses a pid that is not one', () => {
    assert.throws(() => signalCommand('latbench-srs-1', [0], SIGNAL_QUIET), /not a pid/);
    assert.throws(() => signalCommand('latbench-srs-1', [-1], SIGNAL_QUIET), /not a pid/);
  });

  /** The container name reaches a shell, so it is quoted like every other value that does. */
  it('quotes the container name', () => {
    assert.equal(listProcessesCommand("srs'; rm -rf /"), `docker exec 'srs'\\''; rm -rf /' ps -eo pid,args`);
  });
});

/**
 * ⛔⛔ The teardown, and it exists because the failure mode is SILENT. A stopped transcode has not
 * exited, so SRS never spawns a replacement and nothing in the deployment reports it. An arm killed
 * between the stop and the resume would leave that rung quiet for every later broadcast on the host.
 */
describe('putting every transcode back, whatever state it is in', () => {
  it('sends CONT to every ffmpeg rather than to the pids the caller happened to record', () => {
    const command = resumeAllTranscodesCommand('latbench-srs-1');

    assert.match(command, /kill -CONT \$\(pgrep ffmpeg\)/);
    assert.match(command, /^docker exec 'latbench-srs-1'/);
  });

  /** A container with no transcodes running is the ordinary case between broadcasts, not an error. */
  it('succeeds where nothing is running', () => {
    assert.match(resumeAllTranscodesCommand('latbench-srs-1'), /\|\| true/);
  });

  it('quotes the container name', () => {
    assert.match(resumeAllTranscodesCommand("srs'; rm -rf /"), /^docker exec 'srs'\\''; rm -rf \/'/);
  });
});

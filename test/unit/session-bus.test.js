'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SessionBus } = require('../../backend/session-bus');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test.describe('SessionBus idle watchdog', () => {
  test('does not time out while the adapter is still publishing activity', async () => {
    const bus = new SessionBus();
    bus.registerAdapter('fake', {
      async send(_sessionId, _text, { publish }) {
        for (let i = 0; i < 4; i++) {
          await sleep(25);
          publish({ type: 'tool', content: `step ${i}` });
        }
        await sleep(25);
        return { content: 'done' };
      },
    });

    bus.registerSession('s1', 'fake');
    const result = await bus.send('s1', 'go', { idleTimeoutMs: 50 });

    assert.strictEqual(result.content, 'done');
  });

  test('times out when the adapter is silent past the idle window', async () => {
    const bus = new SessionBus();
    bus.registerAdapter('fake', {
      async send() {
        await sleep(80);
        return { content: 'late' };
      },
    });

    bus.registerSession('s1', 'fake');
    await assert.rejects(
      () => bus.send('s1', 'go', { idleTimeoutMs: 30 }),
      /session-bus idle timeout/
    );
  });
});

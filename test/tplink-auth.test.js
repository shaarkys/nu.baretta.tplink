'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getTpLinkClientOptions,
  normalizeTpLinkCredentials,
} = require('../lib/tplink-auth');

test('uses the fixture-established SMART transport for every supported Homey model', () => {
  [
    ['KS225', 'klap'],
    ['S500D', 'aes'],
    ['KS240', 'aes'],
  ].forEach(([model, transport]) => {
    const options = getTpLinkClientOptions(model, {
      deviceUsername: ' account@example.com ',
      devicePassword: '  password with meaningful whitespace  ',
    });

    assert.deepEqual(options, {
      defaultSendOptions: { transport },
      credentials: {
        username: 'account@example.com',
        password: '  password with meaningful whitespace  ',
      },
    });
  });
});

test('does not create partial credentials and preserves a supplied password verbatim', () => {
  assert.deepEqual(
    normalizeTpLinkCredentials({
      deviceUsername: ' user@example.com ',
      devicePassword: '  literal password  ',
    }),
    { username: 'user@example.com', password: '  literal password  ' },
  );
  assert.deepEqual(getTpLinkClientOptions('KS225', { deviceUsername: 'user' }), {
    defaultSendOptions: { transport: 'klap' },
  });
});

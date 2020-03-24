/**
 * Export error constructors (or work-alikes) from lib/internal/errors.js
 *
 * These are ugly hacks.  Hopefully the constructors will be exposed in a
 * future version:  https://github.com/nodejs/node/issues/14554
 *
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const assert = require('assert');
const { kMaxLength } = require('buffer');
const { Deflate, deflate } = require('zlib');


// Get ERR_BUFFER_TOO_LARGE by monkey-patching .end() to pretend more than
// kMaxLength bytes have been read.
assert(
  !hasOwnProperty.call(Deflate.prototype, 'end'),
  'Deflate.prototype does not define end',
);
Deflate.prototype.end = function() {
  this.nread = kMaxLength + 1;
  this.close = () => {};
  this.emit('end');
};
try {
  deflate(Buffer.alloc(0), (err) => {
    assert.strictEqual(err && err.code, 'ERR_BUFFER_TOO_LARGE');
    exports.ERR_BUFFER_TOO_LARGE = err.constructor;
  });
} finally {
  delete Deflate.prototype.end;
}
assert(
  exports.ERR_BUFFER_TOO_LARGE,
  'zlib.deflate calls callback immediately on error',
);


// Get ERR_INVALID_ARG_TYPE by calling Buffer.alloc with an invalid type
try {
  Buffer.alloc(true);
} catch (err) {
  assert.strictEqual(err.code, 'ERR_INVALID_ARG_TYPE');
  exports.ERR_INVALID_ARG_TYPE = err.constructor;
}
assert(
  exports.ERR_INVALID_ARG_TYPE,
  'Buffer.alloc throws for Boolean argument',
);

// eslint-disable-next-line unicorn/custom-error-definition
exports.ERR_SYNC_NOT_SUPPORTED = class InflateAutoError extends Error {
  constructor(target) {
    super();
    let message = 'Synchronous operation is not supported';
    if (target) {
      message += ` by ${target}`;
    }
    message += '.';
    Object.defineProperty(this, 'message', {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.name = 'InflateAutoError';
    this.code = 'ERR_SYNC_NOT_SUPPORTED';
  }
};

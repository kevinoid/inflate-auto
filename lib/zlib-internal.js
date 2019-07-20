/**
 * Zlib internal functions copied from lib/zlib.js @ v7.5.0
 *
 * @copyright Copyright Joyent, Inc. and other Node contributors.
 * @license MIT
 */

'use strict';

/* eslint-disable curly, no-cond-assign, no-self-compare, no-shadow, yoda */

var buffer = require('buffer');

// nodejs/node@197a465 (v7) copied the constants into zlib.constants and
// deprecated accessing constants on zlib directly.
var kMaxLength = buffer.kMaxLength || 0x3fffffff;
var kRangeErrorMessage = 'Cannot create final Buffer. It would be larger ' +
                         'than 0x' + kMaxLength.toString(16) + ' bytes';

function zlibBuffer(engine, buffer, callback) {
  var buffers = [];
  var nread = 0;

  engine.on('error', onError);
  engine.on('end', onEnd);

  engine.end(buffer);
  flow();

  function flow() {
    var chunk;
    while (null !== (chunk = engine.read())) {
      buffers.push(chunk);
      nread += chunk.length;
    }
    engine.once('readable', flow);
  }

  function onError(err) {
    engine.removeListener('end', onEnd);
    engine.removeListener('readable', flow);
    callback(err);
  }

  function onEnd() {
    var buf;
    var err = null;

    if (nread >= kMaxLength) {
      err = new RangeError(kRangeErrorMessage);
    } else {
      buf = Buffer.concat(buffers, nread);
    }

    buffers = [];
    engine.close();
    callback(err, buf);
  }
}

function zlibBufferSync(engine, buffer) {
  if (typeof buffer === 'string')
    buffer =
      // Note:  Test for Buffer.alloc since Buffer.from broken in before alloc
      // eslint-disable-next-line no-buffer-constructor
      Buffer.from && Buffer.alloc ? Buffer.from(buffer) : new Buffer(buffer);
  if (!(buffer instanceof Buffer))
    throw new TypeError('Not a string or buffer');

  var flushFlag = engine._finishFlushFlag;

  return engine._processChunk(buffer, flushFlag);
}

module.exports = {
  zlibBuffer: zlibBuffer,
  zlibBufferSync: zlibBufferSync
};

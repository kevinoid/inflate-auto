/**
 * Zlib internal functions copied from lib/zlib.js @ v5.4.1
 *
 * @copyright Copyright Joyent, Inc. and other Node contributors.
 * @license MIT
 */
'use strict';

/* eslint-disable curly, eqeqeq, no-cond-assign, no-shadow, yoda */

var buffer = require('buffer');
var zlib = require('zlib');

var kMaxLength = buffer.kMaxLength || 0x3fffffff;
var kRangeErrorMessage = 'Cannot create final Buffer. ' +
    'It would be larger than 0x' + kMaxLength.toString(16) + ' bytes';

function isValidFlushFlag(flag) {
  return flag === zlib.Z_NO_FLUSH ||
         flag === zlib.Z_PARTIAL_FLUSH ||
         flag === zlib.Z_SYNC_FLUSH ||
         flag === zlib.Z_FULL_FLUSH ||
         flag === zlib.Z_FINISH ||
         flag === zlib.Z_BLOCK;
}

function validateOptions(opts) {
  if (!opts) {
    return;
  }

  if (opts.flush && !isValidFlushFlag(opts.flush)) {
    throw new Error('Invalid flush flag: ' + opts.flush);
  }
  if (opts.finishFlush && !isValidFlushFlag(opts.finishFlush)) {
    throw new Error('Invalid flush flag: ' + opts.finishFlush);
  }

  if (opts.chunkSize) {
    if (opts.chunkSize < exports.Z_MIN_CHUNK ||
        opts.chunkSize > exports.Z_MAX_CHUNK) {
      throw new Error('Invalid chunk size: ' + opts.chunkSize);
    }
  }

  if (opts.windowBits) {
    if (opts.windowBits < exports.Z_MIN_WINDOWBITS ||
        opts.windowBits > exports.Z_MAX_WINDOWBITS) {
      throw new Error('Invalid windowBits: ' + opts.windowBits);
    }
  }

  if (opts.level) {
    if (opts.level < exports.Z_MIN_LEVEL ||
        opts.level > exports.Z_MAX_LEVEL) {
      throw new Error('Invalid compression level: ' + opts.level);
    }
  }

  if (opts.memLevel) {
    if (opts.memLevel < exports.Z_MIN_MEMLEVEL ||
        opts.memLevel > exports.Z_MAX_MEMLEVEL) {
      throw new Error('Invalid memLevel: ' + opts.memLevel);
    }
  }

  if (opts.strategy) {
    if (opts.strategy != exports.Z_FILTERED &&
        opts.strategy != exports.Z_HUFFMAN_ONLY &&
        opts.strategy != exports.Z_RLE &&
        opts.strategy != exports.Z_FIXED &&
        opts.strategy != exports.Z_DEFAULT_STRATEGY) {
      throw new Error('Invalid strategy: ' + opts.strategy);
    }
  }

  if (opts.dictionary) {
    if (!(opts.dictionary instanceof Buffer)) {
      throw new Error('Invalid dictionary: it should be a Buffer instance');
    }
  }
}

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
    buffer = new Buffer(buffer);
  if (!(buffer instanceof Buffer))
    throw new TypeError('Not a string or buffer');

  engine._setInflater(engine._detectInflaterNow(buffer));
  var flushFlag = zlib.Z_FINISH;

  return engine._inflater._processChunk(buffer, flushFlag);
}

module.exports = {
  isValidFlushFlag: isValidFlushFlag,
  validateOptions: validateOptions,
  zlibBuffer: zlibBuffer,
  zlibBufferSync: zlibBufferSync
};

/**
 * Zlib internal functions copied from lib/zlib.js @ v7.5.0
 *
 * @copyright Copyright Joyent, Inc. and other Node contributors.
 * @license MIT
 */

'use strict';

/* eslint-disable curly, no-cond-assign, no-self-compare, no-shadow, yoda */

var buffer = require('buffer');
var zlib = require('zlib');

// nodejs/node@197a465 (v7) copied the constants into zlib.constants and
// deprecated accessing constants on zlib directly.
var constants = zlib.constants || zlib;
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

function validateOptions(opts) {
  if (!opts) {
    return;
  }

  var chunkSize = opts.chunkSize;
  if (chunkSize !== undefined && chunkSize === chunkSize) {
    if (chunkSize < constants.Z_MIN_CHUNK || !Number.isFinite(chunkSize)) {
      throw new RangeError('Invalid chunk size: ' + chunkSize);
    } else if (opts.chunkSize > kMaxLength) {
      // Throw same Error as Zlib constructor
      // eslint-disable-next-line no-buffer-constructor, no-new
      new Buffer(opts.chunkSize);
    }
  }

  var flush = opts.flush;
  if (flush !== undefined && flush === flush) {
    if (flush < constants.Z_NO_FLUSH ||
        flush > constants.Z_BLOCK ||
        !Number.isFinite(flush))
      throw new RangeError('Invalid flush flag: ' + flush);
  }

  var finishFlush = opts.finishFlush;
  if (finishFlush !== undefined && finishFlush === finishFlush) {
    if (finishFlush < constants.Z_NO_FLUSH ||
        finishFlush > constants.Z_BLOCK ||
        !Number.isFinite(finishFlush)) {
      throw new RangeError('Invalid flush flag: ' + finishFlush);
    }
  }

  var windowBits = opts.windowBits;
  if (windowBits !== undefined && windowBits === windowBits) {
    if (windowBits < constants.Z_MIN_WINDOWBITS ||
        windowBits > constants.Z_MAX_WINDOWBITS ||
        !Number.isFinite(windowBits)) {
      throw new RangeError('Invalid windowBits: ' + windowBits);
    }
  }

  var level = opts.level;
  if (level !== undefined && level === level) {
    if (level < constants.Z_MIN_LEVEL ||
        level > constants.Z_MAX_LEVEL ||
        !Number.isFinite(level)) {
      throw new RangeError('Invalid compression level: ' + level);
    }
  }

  var memLevel = opts.memLevel;
  if (memLevel !== undefined && memLevel === memLevel) {
    if (memLevel < constants.Z_MIN_MEMLEVEL ||
        memLevel > constants.Z_MAX_MEMLEVEL ||
        !Number.isFinite(memLevel)) {
      throw new RangeError('Invalid memLevel: ' + memLevel);
    }
  }

  var strategy = opts.strategy;
  if (strategy !== undefined && strategy === strategy) {
    if (strategy < constants.Z_DEFAULT_STRATEGY ||
        strategy > constants.Z_FIXED ||
        !Number.isFinite(strategy)) {
      throw new TypeError('Invalid strategy: ' + strategy);
    }
  }

  var dictionary = opts.dictionary;
  if (dictionary !== undefined &&
      !(dictionary instanceof Buffer) &&
      // eslint-disable-next-line no-undef
      (!ArrayBuffer.isView || !ArrayBuffer.isView(dictionary))) {
    throw new TypeError(
      'Invalid dictionary: it should be a Buffer, TypedArray, or DataView'
    );
  }
}

module.exports = {
  validateOptions: validateOptions,
  zlibBuffer: zlibBuffer,
  zlibBufferSync: zlibBufferSync
};

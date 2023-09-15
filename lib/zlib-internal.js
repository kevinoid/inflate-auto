/**
 * Zlib internal functions copied from lib/zlib.js @ v13.11.0
 *
 * @copyright Copyright Joyent, Inc. and other Node contributors.
 * @license MIT
 */

// Most of the content in this file is copied verbatim from Node.js.
// Test coverage is not necessary and checking skews coverage numbers.
/* istanbul ignore file */

'use strict';

const {
  ERR_BUFFER_TOO_LARGE,
  ERR_INVALID_ARG_TYPE,
} = require('./errors.js');
const {
  isArrayBufferView,
  isAnyArrayBuffer
} = require('node:util').types;
const {
  kMaxLength
} = require('node:buffer');

function zlibBuffer(engine, buffer, callback) {
  if (typeof callback !== 'function')
    throw new ERR_INVALID_ARG_TYPE('callback', 'function', callback);
  // Streams do not support non-Buffer ArrayBufferViews yet. Convert it to a
  // Buffer without copying.
  if (isArrayBufferView(buffer) &&
      Object.getPrototypeOf(buffer) !== Buffer.prototype) {
    buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else if (isAnyArrayBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  engine.buffers = null;
  engine.nread = 0;
  engine.cb = callback;
  engine.on('data', zlibBufferOnData);
  engine.on('error', zlibBufferOnError);
  engine.on('end', zlibBufferOnEnd);
  engine.end(buffer);
}

function zlibBufferOnData(chunk) {
  if (!this.buffers)
    this.buffers = [chunk];
  else
    this.buffers.push(chunk);
  this.nread += chunk.length;
}

function zlibBufferOnError(err) {
  this.removeAllListeners('end');
  this.cb(err);
}

function zlibBufferOnEnd() {
  let buf;
  let err;
  if (this.nread >= kMaxLength) {
    err = new ERR_BUFFER_TOO_LARGE();
  } else if (this.nread === 0) {
    buf = Buffer.alloc(0);
  } else {
    const bufs = this.buffers;
    buf = (bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, this.nread));
  }
  this.close();
  if (err)
    this.cb(err);
  else if (this._info)
    this.cb(null, { buffer: buf, engine: this });
  else
    this.cb(null, buf);
}

function zlibBufferSync(engine, buffer) {
  if (typeof buffer === 'string') {
    buffer = Buffer.from(buffer);
  } else if (!isArrayBufferView(buffer)) {
    if (isAnyArrayBuffer(buffer)) {
      buffer = Buffer.from(buffer);
    } else {
      throw new ERR_INVALID_ARG_TYPE(
        'buffer',
        ['string', 'Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'],
        buffer
      );
    }
  }
  buffer = engine._processChunk(buffer, engine._finishFlushFlag);
  if (engine._info)
    return { buffer, engine };
  return buffer;
}

module.exports = {
  zlibBuffer,
  zlibBufferSync,
};

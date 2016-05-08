/**
 * @copyright Copyright 2016 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */
'use strict';

var Transform = require('stream').Transform;
var assert = require('assert').ok;
var inherits = require('util').inherits;
var zlib = require('zlib');
var zlibInternal = require('./lib/zlib-internal');

/** Decompressor for DEFLATE compressed data in either zlib, gzip, or "raw"
 * format.
 *
 * This class is intended to be a drop-in replacement for
 * <code>zlib.Inflate</code>, <code>zlib.InflateRaw</code>, and/or
 * <code>zlib.Gunzip</code>.
 *
 * @constructor
 * @extends stream.Transform
 * @param {Object=} opts Options to pass to the constructor for the detected
 * format.
 */
function InflateAuto(opts) {
  if (!(this instanceof InflateAuto)) {
    return new InflateAuto(opts);
  }

  Transform.call(this, opts);

  // Note:  Copy validation code rather than calling Zlib constructor to avoid
  // overhead of zlib binding initialization.
  zlibInternal.validateOptions(opts);

  /** Whether #close() has been called.
   * @private {boolean} */
  this._closed = false;

  // For Zlib compatibility
  this._finishFlushFlag = opts && typeof opts.finishFlush !== 'undefined' ?
    opts.finishFlush : zlib.Z_FINISH;

  /** Instance of a class which does the decoding for the detected data format.
   * @private {stream.Duplex} */
  this._decoder = null;

  /** Options to pass to the format constructor when created.
   * @private {Object} */
  this._opts = opts;

  /* Invariant:
   * At most one of _decoder or _writeBuf is non-null.
   * Since writes are being forwarded or buffered.
   */

  // Behave like Zlib where close is unconditionally called on 'end'
  this.once('end', this.close);
}
inherits(InflateAuto, Transform);

/** Creates an instance of {@link InflateAuto}.
 * Analogous to {@link zlib.createInflate}.
 *
 * @param {Object=} opts Constructor options.
 */
InflateAuto.createInflateAuto = function createInflateAuto(opts) {
  return new InflateAuto(opts);
};

/** Decompresses a compressed <code>Buffer</code>.
 * Analogous to {@link zlib.inflate}.
 *
 * @param {!Buffer} buffer Compressed data to decompress.
 * @param {Object=} opts Decompression options.
 * @param {!function(Error, Buffer=)} callback Callback which receives the
 * decompressed data.
 */
InflateAuto.inflateAuto = function inflateAuto(buffer, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  return zlibInternal.zlibBuffer(new InflateAuto(opts), buffer, callback);
};

if (zlib.inflateSync) {
  /** Decompresses a compressed Buffer synchronously.
   * Analogous to {@link zlib.inflateSync}.
   * Only defined when {@link zlib.inflateSync} is available.
   *
   * @param {!Buffer} buffer Compressed data to decompress.
   * @param {Object=} opts Decompression options.
   * @return {!Buffer} Decompressed data.
   */
  InflateAuto.inflateAutoSync = function inflateAutoSync(buffer, opts) {
    return zlibInternal.zlibBufferSync(new InflateAuto(opts), buffer);
  };
}

/** Maximum number of bytes required for _detectFormat to conclusively
 * determine the format to use.
 * @const
 */
InflateAuto.prototype.SIGNATURE_MAX_LEN = 3;

/** Detects which zlib format may be able to decode data beginning with a
 * given <code>Buffer</code>, returning <code>null</code> when uncertain.
 *
 * <p>This method detects the existence of a gzip or zlib header at the
 * beginning of the <code>Buffer</code> and returns the constructor for the
 * corresponding zlib class:</p>
 *
 * <ul>
 * <li>If a valid gzip header is found, instance of
 *   <code>zlib.Gunzip</code>.</li>
 * <li>If a valid zlib deflate header is found, an instance of
 *   <code>zlib.Deflate</code>.</li>
 * <li>If a valid header of any type could be completed by more data,
 *   <code>null</code>.</li>
 * <li>Otherwise, an instance of <code>zlib.DeflateRaw</code>.</li>
 * </ul>
 *
 * @protected
 * @param {Buffer} chunk Beginning of data for which to deduce the
 * compression format.
 * @return {function(new:stream.Duplex, Object=)}
 * An instance of the zlib type which will decode <code>chunk</code> and
 * subsequent data, or <code>null</code> if <code>chunk</code> is too short to
 * deduce the format conclusively.
 * @see InflateAuto#SIGNATURE_MAX_LEN
 */
InflateAuto.prototype._detectFormat = function _detectFormat(chunk) {
  if (!chunk || !chunk.length) {
    // No data to determine format
    return null;
  }

  // Check for zlib header per Section 2.2 of RFC 1950
  // CM field (least-significant 4 bits) must be 8
  // FCHECK field ensures first 16-bit BE int is a multiple of 31
  if ((chunk[0] & 0x0f) === 8) {
    if (chunk.length === 1) {
      // Can't know yet whether header is valid
      return null;
    } else if ((chunk.readUInt16BE(0) % 31) === 0) {
      // Valid zlib header
      return zlib.Inflate;
    }
  // Check for gzip header per Section 2.3.1 of RFC 1952
  } else if (chunk[0] === 0x1f) {
    if (chunk.length === 1) {
      // Can't know yet whether header is valid
      return null;
    } else if (chunk[1] === 0x8b) {
      if (chunk.length === 2) {
        // Can't know yet whether header is valid
        return null;
      } else if (chunk[2] === 8) {
        // Valid gzip header
        return zlib.Gunzip;
      }
    }
  }

  // Not a valid zlib or gzip header
  return zlib.InflateRaw;
};

/** Detects which zlib format may be able to decode data beginning with a
 * given <code>Buffer</code>, returning a default when uncertain.
 *
 * <p>This method behaves like {@link _detectFormat} except that if a valid
 * header can not be found, <code>zlib.InflateRaw</code> is returned (rather
 * than <code>null</code>).  This method is for use in cases where all data
 * is present and "undecided" is not an option.</p>
 *
 * @protected
 * @param {Buffer} chunk Beginning of data for which to deduce the compression
 * format.
 * @return {function(new:stream.Duplex, Object=)}
 * An instance of the zlib type which will decode chunk and subsequent data.
 * @see #_detectFormat()
 */
InflateAuto.prototype._detectFormatNow = function _detectFormatNow(chunk) {
  return this._detectFormat(chunk) || zlib.InflateRaw;
};

/** Flushes any buffered data when the stream is ending.
 *
 * @protected
 * @param {function(Error=)} callback
 */
InflateAuto.prototype._flush = function _flush(callback) {
  if (this._closed) {
    callback(new Error('zlib binding closed'));
    return;
  }

  if (!this._decoder) {
    // Previous header checks inconclusive.  Must choose one now.
    this.setFormat(this._detectFormatNow(this._writeBuf));
  }

  // callback must not be called until all data has been written.
  // So call on 'end', not 'finish'.
  //
  // Note:  Not called on 'error' since errors events already forwarded
  // and should not emit 'end' after 'error'
  this._decoder.once('end', callback);
  this._decoder.end();
};

/** Process a chunk of data, synchronously or asynchronously.
 *
 * @protected
 * @param {!Buffer} chunk Chunk of data to write.
 * @param {number} flushFlag Flush flag with which to write the data.
 * @param {?function(Error=)=} cb Callback.  Synchronous if falsey.
 * @return {!Buffer|undefined} Decompressed chunk if synchronous, otherwise
 * <code>undefined</code>.
 */
InflateAuto.prototype._processChunk = function _processChunk(chunk, flushFlag,
    cb) {
  if (!this._decoder) {
    this._writeEarly(chunk);
  }

  if (this._decoder) {
    return this._decoder._processChunk.apply(this._decoder, arguments);
  }

  if (!cb) {
    return new Buffer(0);
  }

  process.nextTick(cb);
  return undefined;
};

/** Sets the format which will be used to decode data written to this stream.
 *
 * Note:  The current implementation only allows the format to be set once.
 * Calling this method after the format has been set will throw an exception.
 *
 * @param {function(new:stream.Duplex,Object=)} Format Constructor for the
 * stream class which will be used to decode data written to this stream.
 * @see #_detectFormat()
 */
InflateAuto.prototype.setFormat = function setFormat(Format) {
  var self = this;

  if (this._decoder && Format === this._decoder.constructor) {
    return;
  }

  // We would need to disconnect event handlers and close the previous
  // format to avoid leaking.  No current use case.
  if (this._decoder) {
    throw new Error('Changing format is not supported');
  }

  var format;
  try {
    this._decoder = format = new Format(this._opts);
  } catch (err) {
    self.emit('error', err);
    return;
  }

  format.on('data', function(chunk) {
    self.push(chunk);
  });

  // proxy important events from the format
  // Note:  Same events as Readable.wrap except pause/unpause and close.
  ['destroy', 'error'].forEach(function(event) {
    format.on(event, self.emit.bind(self, event));
  });

  // 'close' handled specially to ensure correct order with 'end'
  this.removeListener('end', this.close);
  var endEmitted = false;
  this.once('end', function() { endEmitted = true; });
  var formatEndEmitted = false;
  format.once('end', function() { formatEndEmitted = true; });
  format.on('close', function() {
    if (formatEndEmitted && !endEmitted) {
      self.once('end', function() { self.emit('close'); });
    } else {
      self.emit('close');
    }
  });

  if (this._queuedMethodCalls) {
    this._queuedMethodCalls.forEach(function(mc) {
      format[mc.name].apply(format, mc.args);
    });
    delete this._queuedMethodCalls;
  }

  if (this._writeBuf) {
    var writeBuf = this._writeBuf;
    delete this._writeBuf;
    this._decoder.write(writeBuf);
  }
};

/** Inflates a chunk of data.
 *
 * @protected
 * @param {Buffer} chunk Chunk of data to inflate.
 * @param {?string} encoding Ignored.
 * @param {?function(Error)=} callback Callback once chunk has been written.
 */
InflateAuto.prototype._transform = function _transform(chunk, encoding,
    callback) {
  if (!this._decoder) {
    if (chunk !== null && !(chunk instanceof Buffer)) {
      callback(new Error('invalid input'));
      return;
    }

    if (this._closed) {
      callback(new Error('zlib binding closed'));
      return;
    }

    this._writeEarly(chunk);
  }

  if (this._decoder) {
    this._decoder.write(chunk, encoding, callback);
    return;
  }

  process.nextTick(callback);
};

/** Writes data to this stream before the format has been detected, performing
 * format detection and buffering as necessary.
 *
 * @private
 * @param {Buffer} chunk Chunk of data to write.
 */
InflateAuto.prototype._writeEarly = function _writeEarly(chunk) {
  if (chunk === null || chunk.length === 0) {
    return;
  }

  var signature;
  if (this._writeBuf) {
    // Only copy up to the max signature size to avoid needless huge copies
    signature = new Buffer(Math.min(
          this.SIGNATURE_MAX_LEN,
          this._writeBuf.length + chunk.length));
    this._writeBuf.copy(signature);
    chunk.copy(signature, this._writeBuf.length);
  } else {
    signature = chunk;
  }

  var Format = this._detectFormat(signature);
  if (!Format) {
    // If this fails, SIGNATURE_MAX_LEN doesn't match _detectFormat
    assert(signature.length ===
        chunk.length + (this._writeBuf ? this._writeBuf.length : 0));
    this._writeBuf = signature;
    return;
  }

  this.setFormat(Format);
};

/** Closes this stream and its underlying resources (zlib handle).
 *
 * @param {?function(Error)=} callback Callback once resources have been
 * freed.
 */
InflateAuto.prototype.close = function close(callback) {
  if (this._decoder) {
    return this._decoder.close.apply(this._decoder, arguments);
  }

  if (callback) {
    process.nextTick(callback);
  }

  if (!this._closed) {
    this._closed = true;
    process.nextTick(this.emit.bind(this, 'close'));
  }

  return undefined;
};

/** Flushes queued writes with a given zlib flush behavior.
 *
 * @param {number=} kind Flush behavior of writes to zlib.  Must be one of the
 * zlib flush constant values.
 * @param {?function(Error)=} callback Callback once data has been flushed.
 */
InflateAuto.prototype.flush = function flush(kind, callback) {
  if (this._decoder) {
    return this._decoder.flush.apply(this._decoder, arguments);
  }

  this._queueMethodCall('flush', arguments);
  return undefined;
};

if (zlib.Inflate.prototype.params) {
  /** Sets the inflate compression parameters.
   *
   * <p>For inflate, this has no effect.  This method is kept for compatibility
   * only.  It is only defined when {@link Inflate.prototype.params} is
   * defined.</p>
   *
   * <p>Note: Parameter checking is not performed if the format hasn't been
   * determined.  Although this is currently possible (since parameters are
   * currently independent of format) it requires instantiating a zlib object
   * with bindings, which is heavy for checking args which haven't changed
   * since this method was added to the Node API.  If there is a use case for
   * such checking, please open an issue.</p>
   *
   * @param {number} level Compression level (between {@link zlib.Z_MIN_LEVEL}
   * and {@link zlib.Z_MAX_LEVEL}).
   * @param {number} strategy Compression strategy (one of the zlib strategy
   * constant values).
   * @param {?function(Error)=} callback Callback once parameters have been
   * set.
   */
  InflateAuto.prototype.params = function params(level, strategy, callback) {
    if (this._decoder) {
      return this._decoder.params.apply(this._decoder, arguments);
    }

    this._queueMethodCall('params', arguments);
    return undefined;
  };
}

/** Discards any buffered data and resets the decoder to its initial state.
 *
 * <p><b>Note:</b>  If a format has been detected, reset does not currently
 * clear the detection (for performance and to reduce complexity).  If there
 * is a real-world use case for this type of "full reset", please open an
 * issue.</p>
 */
InflateAuto.prototype.reset = function reset() {
  if (this._decoder) {
    return this._decoder.reset.apply(this._decoder, arguments);
  }

  assert(!this._closed, 'zlib binding closed');
  delete this._writeBuf;
  return undefined;
};

/** Queues a method call for the format until one is set.
 *
 * <p>In addition to queueing the method call, if the arguments includes a
 * callback function, that function is invoked immediately in order to
 * prevent deadlocks in existing code which doesn't write until the callback
 * completes.</p>
 *
 * @protected
 * @param {string} name Name of the method to call.
 * @param {!(Arguments|Array)} args Arguments to pass to the method call.
 */
InflateAuto.prototype._queueMethodCall = function _queueMethodCall(name, args) {
  assert(!this._decoder);

  // Ideally we would let the proxied method call the callback,
  // but callers may depend on a reply before the next write.
  // So call the callback now to avoid deadlocks.
  var lastArg = args[args.length - 1];
  if (typeof lastArg === 'function') {
    args = Array.prototype.slice.call(args, 0, -1);
    process.nextTick(lastArg);
  }

  if (!this._queuedMethodCalls) {
    this._queuedMethodCalls = [];
  }
  this._queuedMethodCalls.push({name: name, args: args});
};

module.exports = InflateAuto;

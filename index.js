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

/**
 * @constructor
 * @extends stream.Transform
 * @param {Object} opts Options to pass to the zlib constructor.
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

  /** The instance of a zlib class which does the inflating for the detected
   * compression format.
   * @private {zlib.Gunzip|zlib.Inflate|zlib.InflateRaw} */
  this._inflater = null;

  /** Options to pass to the inflater when created.
   * @private {Object} */
  this._options = opts;

  /* Invariant:
   * At most one of _inflater or _writeBuf is non-null.
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

/** Decompresses a compressed Buffer.
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

/** Maximum number of bytes required for _detectInflater to conclusively
 * determine the inflater to use.
 * @const
 */
InflateAuto.prototype.SIGNATURE_MAX_LEN = 3;

/** Detects which zlib inflater may be able to inflate data beginning with a
 * given Buffer, returning null when uncertain.
 *
 * This method detects the existence of a gzip or zlib header at the beginning
 * of the Buffer and returns an instance of the corresponding zlib class:
 * - If a valid gzip header is found, instance of zlib.Gunzip.
 * - If a valid zlib deflate header is found, an instance of zlib.Deflate.
 * - If a valid header of any type could be completed by more data, null.
 * - Otherwise, an instance of zlib.DeflateRaw.
 *
 * @protected
 * @param {buffer.Buffer} chunk Beginning of data for which to deduce the
 * compression format.
 * @return {zlib.Gunzip|zlib.Inflate|zlib.InflateRaw} An instance of the zlib
 * type which will inflate chunk and subsequent data, or null if chunk is too
 * short to deduce the format conclusively.
 */
InflateAuto.prototype._detectInflater = function _detectInflater(chunk) {
  if (!chunk || !chunk.length) {
    // No data to determine inflater
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
      return new zlib.Inflate(this._options);
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
        return new zlib.Gunzip(this._options);
      }
    }
  }

  // Not a valid zlib or gzip header
  return new zlib.InflateRaw(this._options);
};

/** Detects which zlib inflater may be able to inflate data beginning with a
 * given Buffer, returning a default when uncertain.
 *
 * This method behaves like _detectInflater except that if a valid header can
 * not be found, an instance of zlib.InflateRaw is returned (rather than null)
 * for use in cases where all data is present and "undecided" is not an option.
 *
 * @protected
 * @param {buffer.Buffer} chunk Beginning of data for which to deduce the
 * compression format.
 * @return {!(zlib.Gunzip|zlib.Inflate|zlib.InflateRaw)} An instance of the
 * zlib type which will inflate chunk and subsequent data.
 * @see #_detectInflater()
 */
InflateAuto.prototype._detectInflaterNow = function _detectInflaterNow(chunk) {
  return this._detectInflater(chunk) || new zlib.InflateRaw(this._options);
};

/** Flushes any buffered data when the stream is ending.
 * @protected
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype._flush = function _flush(callback) {
  var chunk;
  if (this._writeBuf) {
    assert(!this._inflater);

    // Previous header checks inconclusive.  Must choose one now.
    this._setInflater(this._detectInflaterNow(this._writeBuf));
    chunk = this._writeBuf;
    delete this._writeBuf;
  }

  if (this._inflater) {
    // callback must not be called until all data has been written.
    // So call on 'end', not 'finish'.
    //
    // Note:  Not called on 'error' since errors events already forwarded
    // and should not emit 'end' after 'error'
    this._inflater.once('end', callback);
    return this._inflater.end(chunk);
  }

  if (this._closed) {
    return callback(new Error('zlib binding closed'));
  }

  // No data has been written and close has not been called.  Nothing to do.
  process.nextTick(callback);
};

/** Sets the inflater class.
 *
 * @protected
 * @param {!stream.Duplex} inflater Stream which will be used to inflate data
 * written to this stream.
 * @see #_detectInflater()
 */
InflateAuto.prototype._setInflater = function _setInflater(inflater) {
  var self = this;

  // We would need to disconnect event handlers and close the previous
  // inflater to avoid leaking.  No current use case.
  assert(!this._inflater, 'changing inflater not supported');

  this._inflater = inflater;

  inflater.on('data', function(chunk) {
    self.push(chunk);
  });

  // proxy important events from the inflater
  // Note:  Same events as Readable.wrap except pause/unpause and close.
  ['destroy', 'error'].forEach(function(event) {
    inflater.on(event, self.emit.bind(self, event));
  });

  // 'close' handled specially to ensure correct order with 'end'
  this.removeListener('end', this.close);
  var endEmitted = false;
  this.once('end', function() { endEmitted = true; });
  var inflaterEndEmitted = false;
  inflater.once('end', function() { inflaterEndEmitted = true; });
  inflater.on('close', function() {
    if (inflaterEndEmitted && !endEmitted) {
      self.once('end', function() { self.emit('close'); });
    } else {
      self.emit('close');
    }
  });

  if (this._queuedMethodCalls) {
    this._queuedMethodCalls.forEach(function(mc) {
      inflater[mc.name].apply(inflater, mc.args);
    });
    delete this._queuedMethodCalls;
  }
};

/** Deflates a chunk of data.
 *
 * @protected
 * @param {buffer.Buffer} chunk Chunk of data to deflate.
 * @param {?string} encoding Ignored.
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype._transform = function _transform(chunk, encoding,
    callback) {
  if (this._inflater) {
    return this._inflater.write(chunk, encoding, callback);
  }

  if (chunk !== null && !(chunk instanceof Buffer)) {
    return callback(new Error('invalid input'));
  }

  if (this._closed) {
    return callback(new Error('zlib binding closed'));
  }

  if (chunk === null || chunk.length === 0) {
    return process.nextTick(callback);
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

  var inflater = this._detectInflater(signature);
  if (!inflater) {
    // If this fails, SIGNATURE_MAX_LEN doesn't match _detectInflaters
    assert(signature.length ===
        chunk.length + (this._writeBuf ? this._writeBuf.length : 0));
    this._writeBuf = signature;
    return process.nextTick(callback);
  }

  this._setInflater(inflater);

  if (this._writeBuf) {
    this._inflater.write(this._writeBuf);
    delete this._writeBuf;
  }

  return this._inflater.write(chunk, encoding, callback);
};

/** Closes this stream and its underlying resources (zlib handle).
 *
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype.close = function close(callback) {
  if (this._inflater) {
    return this._inflater.close.apply(this._inflater, arguments);
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
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype.flush = function flush(kind, callback) {
  if (this._inflater) {
    return this._inflater.flush.apply(this._inflater, arguments);
  }

  this._queueMethodCall('flush', arguments);
  return undefined;
};

if (zlib.Inflate.prototype.params) {
  /** Sets the deflate compression parameters.
   *
   * <p>For inflate, this has no effect.  This method is kept for compatibility
   * only.  It is only defined when {@link Inflate.prototype.params} is
   * defined.</p>
   *
   * <p>Note: Parameter checking is not performed if the format hasn't been
   * determined.  Although this is currently possible (since parameters are
   * currently independent of format) it requires instantiating a zlib object
   * with bindings, which is heavy for checking args which haven't changed since
   * this method was added to the Node API.  If there is a use case for such
   * checking, please open an issue.</p>
   *
   * @param {number} level Compression level (between {@link zlib.Z_MIN_LEVEL}
   * and {@link zlib.Z_MAX_LEVEL}).
   * @param {number} strategy Compression strategy (one of the zlib strategy
   * constant values).
   * @param {?function(Error)=} callback
   */
  InflateAuto.prototype.params = function params(level, strategy, callback) {
    if (this._inflater) {
      return this._inflater.params.apply(this._inflater, arguments);
    }

    this._queueMethodCall('params', arguments);
    return undefined;
  };
}

/** Discards any buffered data and resets the decoder to its initial state.
 *
 * Note:  If a format has been detected, reset does not currently clear the
 * detection (for performance and to reduce unnecessary complexity).  If there
 * is a real-world use case for this type of "full reset", please open an
 * issue.
 */
InflateAuto.prototype.reset = function reset() {
  if (this._inflater) {
    return this._inflater.reset.apply(this._inflater, arguments);
  }

  assert(!this._closed, 'zlib binding closed');
  delete this._writeBuf;
  return undefined;
};

/** Queues a method call for the inflater until one is set.
 *
 * In addition to queueing the method call, if the arguments includes a
 * callback function, that function is invoked immediately in order to
 * prevent deadlocks in existing code which doesn't write until the callback
 * completes.
 *
 * @protected
 * @param {string} name Name of the method to call.
 * @param {!(Arguments|Array)} args Arguments to apply to the method call.
 */
InflateAuto.prototype._queueMethodCall = function _queueMethodCall(name, args) {
  assert(!this._inflater);

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

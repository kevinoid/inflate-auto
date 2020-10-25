/**
 * @copyright Copyright 2016-2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const assert = require('assert');
const stream = require('stream');
const streamCompare = require('stream-compare');
const { inspect, promisify } = require('util');
const zlib = require('zlib');
const assignOwnPropertyDescriptors =
  require('../test-lib/assign-own-property-descriptors.js');
const InflateAuto = require('..');

const { AssertionError } = assert;
const nodeVersion = process.version.slice(1).split('.').map(Number);

// streamCompare options to read in flowing mode with exact matching of
// event data for all events listed in the API.
const COMPARE_OPTIONS = {
  compare: assert.deepStrictEqual,
  endEvents: ['close', 'end', 'error'],
  events: ['close', 'data', 'destroy', 'end', 'error', 'finish', 'pipe'],
  readPolicy: 'none',
};

const TEST_DATA = {
  empty: Buffer.alloc(0),
  large: Buffer.alloc(1024),
  // 'normal' is the default for not-data-specific tests
  normal: Buffer.from('uncompressed data'),
};

/* eslint-disable comma-spacing */
const SUPPORTED_FORMATS = [
  {
    Compress: zlib.Gzip,
    Decompress: zlib.Gunzip,
    compress: zlib.gzip,
    compressSync: zlib.gzipSync,
    corruptChecksum: function corruptGzipChecksum(compressed) {
      const invalid = Buffer.from(compressed);
      // gzip format has 4-byte CRC32 before 4-byte size at end
      // eslint-disable-next-line no-bitwise
      invalid[invalid.length - 5] = invalid[invalid.length - 5] ^ 0x1;
      return invalid;
    },
    data: TEST_DATA,
    dataCompressed: {
      // zlib.gzipSync(data.empty)
      empty: Buffer.from([31,139,8,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0,0,0]),
      // zlib.gzipSync(data.large)
      large: Buffer.from([31,139,8,0,0,0,0,0,0,3,99,96,24,5,163,96,20,140,84,0,
        0,46,175,181,239,0,4,0,0]),
      // zlib.gzipSync(data.normal)
      normal: Buffer.from([31,139,8,0,0,0,0,0,0,3,43,205,75,206,207,45,40,74,45,
        46,78,77,81,72,73,44,73,4,0,239,231,69,217,17,0,0,0]),
    },
    decompress: zlib.gunzip,
    decompressSync: zlib.gunzipSync,
    header: Buffer.from([31,139,8]),
  },
  {
    Compress: zlib.Deflate,
    Decompress: zlib.Inflate,
    compress: zlib.deflate,
    compressSync: zlib.deflateSync,
    corruptChecksum: function corruptZlibChecksum(compressed) {
      const invalid = Buffer.from(compressed);
      // zlib format has 4-byte Adler-32 at end
      // eslint-disable-next-line no-bitwise
      invalid[invalid.length - 1] = invalid[invalid.length - 1] ^ 0x1;
      return invalid;
    },
    data: TEST_DATA,
    dataCompressed: {
      // zlib.deflateSync(data.empty)
      empty: Buffer.from([120,156,3,0,0,0,0,1]),
      // zlib.deflateSync(data.large)
      large: Buffer.from([120,156,99,96,24,5,163,96,20,140,84,0,0,4,0,0,1]),
      // zlib.deflateSync(data.normal)
      normal: Buffer.from([120,156,43,205,75,206,207,45,40,74,45,46,78,77,81,72,
        73,44,73,4,0,63,144,6,211]),
      // zlib.deflateSync(data.normal, {dictionary: data.normal})
      normalWithDict:
        Buffer.from([120,187,63,144,6,211,43,69,23,0,0,63,144,6,211]),
    },
    decompress: zlib.inflate,
    decompressSync: zlib.inflateSync,
    header: Buffer.from([120,156]),
  },
  {
    Compress: zlib.DeflateRaw,
    Decompress: zlib.InflateRaw,
    compress: zlib.deflateRaw,
    compressSync: zlib.deflateRawSync,
    data: TEST_DATA,
    dataCompressed: {
      // zlib.deflateRawSync(data.empty)
      empty: Buffer.from([3,0]),
      // zlib.deflateRawSync(data.large)
      large: Buffer.from([99,96,24,5,163,96,20,140,84,0,0]),
      // zlib.deflateRawSync(data.normal)
      normal: Buffer.from([43,205,75,206,207,45,40,74,45,46,78,77,81,72,73,44,
        73,4,0]),
      // zlib.deflateRawSync(data.normal, {dictionary: data.normal})
      normalWithDict: Buffer.from([43,69,23,0,0]),
    },
    decompress: zlib.inflateRaw,
    decompressSync: zlib.inflateRawSync,
    header: Buffer.alloc(0),
    isDefault: true,
  },
];
/* eslint-enable comma-spacing */

function assertInstanceOf(obj, ctor) {
  if (!(obj instanceof ctor)) {
    assert.fail(
      obj,
      ctor,
      null,
      'instanceof',
    );
  }
}

/**
 * Compare stream states where 'finish' may not occur on the zlib stream.
 *
 * If InflateRaw#end() is called with an invalid prefix, it emits 'error'
 * without 'finish'.  This is difficult to mimic using Transform because
 * 'finish' is emitted after _transform, not after _flush
 * https://nodejs.org/api/stream.html#stream_events_finish_and_end
 * so _transform would need to call _decoder.end() and delay the callback
 * until 'finish' is emitted when _writableState.ending is true (after a tick,
 * since it is not set when called) and avoid calling .end() in _flush.  This
 * complexity is not currently justified, so this compare function ignores
 * 'finish' before 'error'.
 *
 * @private
 */
function compareMaybeFinish(stateAuto, stateZlib) {
  try {
    assert.deepStrictEqual(stateAuto, stateZlib);
  } catch (err) {
    // Remove 'finish' immediately before 'error' and re-compare
    const finishInd =
      stateAuto.events.findIndex((event) => event.name === 'finish');
    const errorInd =
      stateAuto.events.findIndex((event) => event.name === 'error');
    if (errorInd === finishInd + 1) {
      stateAuto.events.splice(finishInd, 1);
      assert.deepStrictEqual(stateAuto, stateZlib);
    } else {
      throw err;
    }
  }
}

/**
 * Make an Error object with the same properties as a given object.
 *
 * @private
 */
function makeError(source) {
  if (Object.getPrototypeOf(source) === Error.prototype) {
    return source;
  }
  const error = new Error(source.message);
  assignOwnPropertyDescriptors(error, source);
  return error;
}

function neverCalled() {
  throw new Error('should not be called');
}

/** Asserts that writing a given chunk to a given stream produces an error
 * which satisfies given assertions.
 *
 * This function should only be used for errors specific to InflateAuto.
 * Other errors should be tested using stream-compare.
 *
 * @param {!stream.Writable} writable Stream to be written.
 * @param {!Buffer} chunk Data to write to writable.
 * @param {function(Error=)} assertError Assertions for error produced (if any).
 * @returns {Promise} Promise for assertion completion.
 */
function assertWriteError(writable, chunk, assertError) {
  return new Promise((resolve, reject) => {
    // 'error' stopped being emitted with autoDestroy: true in
    // nodejs/node@f24b070cb7f for v12.0.0
    // nodejs/node@d6bcf8b98b for v11.2.0
    // nodejs/node@a1b253a416 for v10.16.0
    // Previous behavior was restored in nodejs/node@f8f6a21580 for v13.0.0.
    // Therefore, this function asserts that 'error' is emitted at most once,
    // rather than exactly once.
    let errorEmitted = false;
    writable.on('error', (err) => {
      if (errorEmitted) {
        reject(new AssertionError({
          message: 'error should be emitted at most once',
          operator: 'fail',
        }));
        return;
      }
      errorEmitted = true;

      try {
        assertError(err);
      } catch (errAssert) {
        reject(errAssert);
      }
    });

    writable.on('end', () => reject(new AssertionError({
      message: 'end should not be emitted',
      operator: 'fail',
    })));

    writable.write(chunk, (err) => {
      try {
        assertError(err);
        resolve();
      } catch (errAssert) {
        reject(errAssert);
      }
    });
  });
}

function normalizeEvent(event) {
  if (event.name === 'error') {
    const normEvent = { ...event };
    normEvent.args = normEvent.args.map(makeError);
    return normEvent;
  }

  return event;
}

/**
 * Compares StreamStates ignoring the prototype of Error events.
 *
 * @private
 */
function compareNoErrorTypes(actualState, expectedState) {
  const actual = { ...actualState };
  const expected = { ...expectedState };

  actual.events = actual.events.map(normalizeEvent);
  expected.events = expected.events.map(normalizeEvent);

  assert.deepStrictEqual(actual, expected);
}

/**
 * Defines tests which are run for a given format.
 *
 * @private
 */
function defineFormatTests(format) {
  const emptyCompressed = format.dataCompressed.empty;
  const largeCompressed = format.dataCompressed.large;

  // Data with a different header than the expected one
  let otherCompressed, otherHeader;
  if (format === SUPPORTED_FORMATS[0]) {
    otherCompressed = SUPPORTED_FORMATS[1].dataCompressed.normal;
    otherHeader = SUPPORTED_FORMATS[1].header;
  } else {
    otherCompressed = SUPPORTED_FORMATS[0].dataCompressed.normal;
    otherHeader = SUPPORTED_FORMATS[0].header;
  }

  const compressed = format.dataCompressed.normal;
  const uncompressed = format.data.normal;

  const {
    Decompress,
    compress,
    corruptChecksum,
    decompress,
    decompressSync,
    isDefault: isDefaultFormat,
    header,
  } = format;
  const headerLen = header.length;

  describe('.inflateAuto', () => {
    it('decompresses all data in a single call', (done) => {
      decompress(compressed, (errDecompress, dataDecompress) => {
        assert.ifError(errDecompress);
        InflateAuto.inflateAuto(compressed, (errAuto, dataAuto) => {
          assert.ifError(errAuto);
          assert.deepStrictEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('handles compressed empty data', (done) => {
      decompress(emptyCompressed, (errDecompress, dataDecompress) => {
        assert.ifError(errDecompress);
        InflateAuto.inflateAuto(emptyCompressed, (errAuto, dataAuto) => {
          assert.ifError(errAuto);
          assert.deepStrictEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('supports non-Buffer TypedArray', (done) => {
      const compressedTA = new Uint8Array(compressed);
      decompress(compressedTA, (errDecompress, dataDecompress) => {
        assert.ifError(errDecompress);
        InflateAuto.inflateAuto(compressedTA, (errAuto, dataAuto) => {
          assert.deepStrictEqual(errAuto, errDecompress);
          assert.deepStrictEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('supports ArrayBuffer', (done) => {
      const compressedBuf = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.length,
      );
      decompress(compressedBuf, (errDecompress, dataDecompress) => {
        InflateAuto.inflateAuto(compressedBuf, (errAuto, dataAuto) => {
          assert.deepStrictEqual(errAuto, errDecompress);
          assert.deepStrictEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('handles null like zlib', function() {
      // Before nodejs/node#24929 (v12) an exception was not thrown and an
      // unhandled error would occur when callback attempted.
      // Don't mimic this behavior.
      if (nodeVersion[0] < 12) {
        this.skip();
        return;
      }

      let errInflate;
      try { decompress(null); } catch (err) { errInflate = err; }

      let errAuto;
      try { InflateAuto.inflateAuto(null); } catch (err) { errAuto = err; }

      assert.deepStrictEqual(errAuto, errInflate);
    });

    it('throws when called without callback', function() {
      // Before nodejs/node#24929 (v12) an exception was not thrown and an
      // unhandled error would occur when callback attempted.
      // Don't mimic this behavior.
      if (nodeVersion[0] < 12) {
        this.skip();
        return;
      }

      let errInflate;
      try { decompress(compressed); } catch (err) { errInflate = err; }

      let errAuto;
      try {
        InflateAuto.inflateAuto(compressed);
      } catch (err) {
        errAuto = err;
      }

      assert.deepStrictEqual(errAuto, errInflate);
    });

    it('can accept options argument', (done) => {
      const opts = { chunkSize: zlib.Z_MIN_CHUNK };
      InflateAuto.inflateAuto(compressed, opts, (errAuto, dataAuto) => {
        assert.ifError(errAuto);

        // Node 0.10 does not support opts
        if (decompress.length < 3) {
          done();
          return;
        }

        decompress(compressed, opts, (errDecompress, dataDecompress) => {
          assert.ifError(errDecompress);
          assert.deepStrictEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('supports options.info', (done) => {
      const opts = { info: true };
      decompress(compressed, opts, (errDecompress, dataDecompress) => {
        assert.ifError(errDecompress);
        assertInstanceOf(dataDecompress.engine, Decompress);

        InflateAuto.inflateAuto(compressed, opts, (errAuto, dataAuto) => {
          assert.ifError(errAuto);
          assertInstanceOf(dataAuto.engine, InflateAuto);

          dataAuto.engine = dataDecompress.engine;
          assert.deepStrictEqual(dataAuto, dataDecompress);

          done();
        });
      });
    });

    it('can use PassThrough as defaultFormat', (done) => {
      const opts = { defaultFormat: stream.PassThrough };
      InflateAuto.inflateAuto(uncompressed, opts, (errAuto, dataAuto) => {
        assert.ifError(errAuto);
        assert.deepStrictEqual(dataAuto, uncompressed);
        done();
      });
    });

    // Node 0.10 decompress did not accept options argument
    if (decompress.length > 2) {
      it('handles string defaultEncoding like zlib', (done) => {
        const compressedStr = compressed.toString('binary');
        const opts = { defaultEncoding: 'binary' };
        decompress(
          compressedStr,
          opts,
          (errDecompress, dataDecompress) => {
            InflateAuto.inflateAuto(
              compressedStr,
              opts,
              (errAuto, dataAuto) => {
                assert.deepStrictEqual(errAuto, errDecompress);
                assert.deepStrictEqual(dataAuto, dataDecompress);
                done();
              },
            );
          },
        );
      });
    }

    if (isDefaultFormat) {
      it('passes format Error to the callback like zlib', (done) => {
        const zeros = Buffer.alloc(20);
        decompress(zeros, (errDecompress, dataDecompress) => {
          assert(errDecompress, 'expected Error to test');
          InflateAuto.inflateAuto(zeros, (errAuto, dataAuto) => {
            assert.deepStrictEqual(errAuto, errDecompress);
            assert.deepStrictEqual(dataAuto, dataDecompress);
            done();
          });
        });
      });

      it('handles truncated header like zlib', (done) => {
        const trunc = compressed.slice(0, 1);
        decompress(trunc, (errDecompress, dataDecompress) => {
          InflateAuto.inflateAuto(trunc, (errAuto, dataAuto) => {
            assert.deepStrictEqual(errAuto, errDecompress);
            assert.deepStrictEqual(dataAuto, dataDecompress);
            done();
          });
        });
      });

      // Default string decoding as utf8 mangles the data, resulting in an
      // invalid format, so error equality is only guaranteed for default fmt
      it('handles string argument like zlib', (done) => {
        const compressedStr = compressed.toString('binary');
        decompress(compressedStr, (errDecompress, dataDecompress) => {
          InflateAuto.inflateAuto(compressedStr, (errAuto, dataAuto) => {
            assert.deepStrictEqual(errAuto, errDecompress);
            assert.deepStrictEqual(dataAuto, dataDecompress);
            done();
          });
        });
      });
    }
  });

  it('as synchronous function', () => {
    const dataDecompress = decompressSync(compressed);
    const dataAuto = InflateAuto.inflateAutoSync(compressed);
    assert.deepStrictEqual(dataAuto, dataDecompress);
  });

  it('single-write with immediate end', () => {
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    result.checkpoint();
    zlibStream.end(compressed);
    inflateAuto.end(compressed);
    result.checkpoint();
    return result;
  });

  it('single-write delayed end', () => {
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

    const zlibWriteP = promisify(zlibStream.write);
    const autoWriteP = promisify(inflateAuto.write);

    return Promise.all([
      zlibWriteP.call(zlibStream, compressed),
      autoWriteP.call(inflateAuto, compressed),
    ]).then(() => {
      result.checkpoint();
      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();

      return result;
    });
  });

  [1, 2, 3].forEach((blockSize) => {
    it(`${blockSize} byte writes`, () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      for (let i = 0; i < compressed.length; i += 1) {
        const block = compressed.slice(i * blockSize, (i + 1) * blockSize);
        zlibStream.write(block);
        inflateAuto.write(block);
        result.checkpoint();
      }

      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();

      return result;
    });
  });

  if (isDefaultFormat) {
    it('no writes', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();
      return result;
    });
  }

  it('no data after header', () => {
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(header);
    inflateAuto.end(header);
    result.checkpoint();
    return result;
  });

  if (isDefaultFormat) {
    SUPPORTED_FORMATS.forEach((supportedFormat) => {
      const formatName = supportedFormat.Compress.name;
      const formatHeader = supportedFormat.header;
      const formatHeaderLen = formatHeader.length;

      function testPartialHeader(len) {
        it(`${len} bytes of ${formatName} header`, () => {
          const zlibStream = new Decompress();
          const inflateAuto = new InflateAuto();
          const compareOptions = {
            ...COMPARE_OPTIONS,
            compare: compareMaybeFinish,
          };
          const result =
            streamCompare(inflateAuto, zlibStream, compareOptions);
          const partial = formatHeader.slice(0, len);
          zlibStream.end(partial);
          inflateAuto.end(partial);
          result.checkpoint();
          return result;
        });
      }
      for (let i = 1; i < formatHeaderLen; i += 1) {
        testPartialHeader(i);
      }
    });
  }

  it('compressed empty data', () => {
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(emptyCompressed);
    inflateAuto.end(emptyCompressed);
    result.checkpoint();
    return result;
  });

  // This behavior changed in node v5 and later due to
  // https://github.com/nodejs/node/pull/2595
  it('handles truncated compressed data', () => {
    // Truncate shortly after the header (if any) for type detection
    const truncated = compressed.slice(0, headerLen + 1);
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(truncated);
    inflateAuto.end(truncated);
    result.checkpoint();
    return result;
  });

  // This behavior changed in node v6 and later due to
  // https://github.com/nodejs/node/pull/5120
  it('handles concatenated compressed data', () => {
    const doubledata = Buffer.concat([compressed, compressed]);
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(doubledata);
    inflateAuto.end(doubledata);
    result.checkpoint();
    return result;
  });

  it('handles concatenated empty compressed data', () => {
    const doubleempty = Buffer.concat([emptyCompressed, emptyCompressed]);
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(doubleempty);
    inflateAuto.end(doubleempty);
    result.checkpoint();
    return result;
  });

  it('handles concatenated 0', () => {
    const zeros = Buffer.alloc(20);
    const compressedWithZeros = Buffer.concat([compressed, zeros]);
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(compressedWithZeros);
    inflateAuto.end(compressedWithZeros);
    result.checkpoint();
    return result;
  });

  it('handles concatenated garbage', () => {
    const garbage = Buffer.alloc(20, 42);
    const compressedWithGarbage = Buffer.concat([compressed, garbage]);
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(compressedWithGarbage);
    inflateAuto.end(compressedWithGarbage);
    result.checkpoint();
    return result;
  });

  it('handles corrupted compressed data', () => {
    const corrupted = Buffer.from(compressed);
    // Leave signature intact
    corrupted.fill(42, headerLen);
    const zlibStream = new Decompress();
    const inflateAuto = new InflateAuto();
    const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(corrupted);
    inflateAuto.end(corrupted);
    result.checkpoint();
    return result;
  });

  if (corruptChecksum) {
    it('corrupted checksum', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      const invalid = corruptChecksum(compressed);
      zlibStream.end(invalid);
      inflateAuto.end(invalid);
      result.checkpoint();
      return result;
    });
  }

  const compressedWithDict = format.dataCompressed.normalWithDict;
  if (compressedWithDict && compress.length === 3) {
    it('handles dictionary', () => {
      const options = { dictionary: uncompressed };
      const zlibStream = new Decompress(options);
      const inflateAuto = new InflateAuto(options);
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end(compressedWithDict);
      inflateAuto.end(compressedWithDict);
      result.checkpoint();
      return result;
    });

    it('handles missing dictionary', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end(compressedWithDict);
      inflateAuto.end(compressedWithDict);
      result.checkpoint();
      return result;
    });
  }

  it('emits error for format error in _flush', (done) => {
    const inflateAuto = new InflateAuto({ defaultFormat: null });
    const truncated = compressed.slice(0, 1);
    inflateAuto.on('error', (err) => {
      assert(err, 'expected format error');
      assert(/format/i.test(err.message));
      assert.deepStrictEqual(err.data, truncated);
      done();
    });
    inflateAuto.end(truncated);
  });

  // For objectMode: true validation is done in _transform.  Check we match.
  // This causes an assertion failure on Node v9.  Skip test on this version.
  // See https://github.com/nodejs/node/pull/16960
  if (nodeVersion[0] !== 9) {
    it('errors on write of invalid type', () => {
      const options = { objectMode: true };
      const zlibStream = new Decompress(options);
      const inflateAuto = new InflateAuto(options);
      const compareOptions = { ...COMPARE_OPTIONS };
      compareOptions.endEvents = ['end'];

      // nodejs/node@b514bd231 (Node 8) changed Error to TypeError.
      if (nodeVersion[0] < 8) {
        compareOptions.compare = compareNoErrorTypes;
      }

      const result = streamCompare(inflateAuto, zlibStream, compareOptions);

      let errInflate;
      try {
        zlibStream.write(true);
      } catch (err) {
        errInflate = err;
      }

      let errAuto;
      try {
        inflateAuto.write(true);
      } catch (err) {
        errAuto = err;
      }

      assert.deepStrictEqual(errAuto, errInflate);

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();
      return result;
    });
  }

  describe('.inflateAutoSync()', () => {
    it('invalid type synchronously', () => {
      let errInflate;
      try {
        decompressSync(true);
      } catch (err) {
        errInflate = err;
      }

      let errAuto;
      try {
        InflateAuto.inflateAutoSync(true);
      } catch (err) {
        errAuto = err;
      }

      if (errAuto && errInflate) {
        // message changed in 2ced07c (Node 8).  Ignore in comparison.
        errAuto.message = errInflate.message;
      }

      assert.deepStrictEqual(errAuto, errInflate);
    });

    it('supports non-Buffer TypedArray', () => {
      const compressedTA = new Uint8Array(compressed);
      const dataDecompress = decompressSync(compressedTA);
      const dataAuto = InflateAuto.inflateAutoSync(compressedTA);
      assert.deepStrictEqual(dataAuto, dataDecompress);
    });

    it('supports ArrayBuffer', () => {
      const compressedBuf = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.length,
      );
      const dataDecompress = decompressSync(compressedBuf);
      const dataAuto = InflateAuto.inflateAutoSync(compressedBuf);
      assert.deepStrictEqual(dataAuto, dataDecompress);
    });

    it('supports options.info', () => {
      const options = { info: true };

      const dataDecompress = decompressSync(compressed, options);
      assertInstanceOf(dataDecompress.engine, Decompress);

      const dataAuto = InflateAuto.inflateAutoSync(compressed, options);
      assertInstanceOf(dataAuto.engine, InflateAuto);

      dataAuto.engine = dataDecompress.engine;
      assert.deepStrictEqual(dataAuto, dataDecompress);

      assert.deepStrictEqual(dataAuto[0], dataDecompress[0]);
    });

    if (isDefaultFormat) {
      SUPPORTED_FORMATS.forEach((supportedFormat) => {
        const formatName = supportedFormat.Compress.name;
        const formatHeader = supportedFormat.header;
        if (formatHeader.length <= 1) {
          return;
        }

        it(`partial ${formatName} header`, () => {
          const partial = formatHeader.slice(0, 1);

          let dataInflate, errInflate;
          try {
            dataInflate = decompressSync(partial);
          } catch (err) {
            errInflate = err;
          }

          let dataAuto, errAuto;
          try {
            dataAuto = InflateAuto.inflateAutoSync(partial);
          } catch (err) {
            errAuto = err;
          }

          assert.deepStrictEqual(errAuto, errInflate);
          assert.deepStrictEqual(dataAuto, dataInflate);
        });
      });
    }

    it('can use PassThrough as defaultFormat', () => {
      const opts = { defaultFormat: stream.PassThrough };
      const dataAuto = InflateAuto.inflateAutoSync(uncompressed, opts);
      assert.deepStrictEqual(dataAuto, uncompressed);
    });

    if (isDefaultFormat) {
      // Default string decoding as utf8 mangles the data, resulting in an
      // invalid format, so error equality is only guaranteed for default fmt
      it('handles string argument like zlib', () => {
        const compressedStr = compressed.toString('binary');

        let dataInflate, errInflate;
        try {
          dataInflate = decompressSync(compressedStr);
        } catch (err) {
          errInflate = err;
        }

        let dataAuto, errAuto;
        try {
          dataAuto = InflateAuto.inflateAutoSync(compressedStr);
        } catch (err) {
          errAuto = err;
        }

        assert.deepStrictEqual(errAuto, errInflate);
        assert.deepStrictEqual(dataAuto, dataInflate);
      });

      // The *Sync methods call Buffer.from on arg without encoding before
      // passing to _processChunk.  So it gets mangled.
      it('handles string with defaultEncoding like zlib', () => {
        const compressedStr = compressed.toString('binary');
        const opts = { defaultEncoding: 'binary' };

        let dataInflate, errInflate;
        try {
          dataInflate = decompressSync(compressedStr, opts);
        } catch (err) {
          errInflate = err;
        }

        let dataAuto, errAuto;
        try {
          dataAuto = InflateAuto.inflateAutoSync(compressedStr, opts);
        } catch (err) {
          errAuto = err;
        }

        assert.deepStrictEqual(errAuto, errInflate);
        assert.deepStrictEqual(dataAuto, dataInflate);
      });
    }
  });

  function itValidatesOptions(options) {
    it(inspect(options), () => {
      let errInflate;
      // eslint-disable-next-line no-new
      try { new Decompress(options); } catch (err) { errInflate = err; }

      let errAuto;
      // eslint-disable-next-line no-new
      try { new InflateAuto(options); } catch (err) { errAuto = err; }

      assert.deepStrictEqual(errAuto, errInflate);
    });
  }

  function itEmitsErrorForOptions(options) {
    it(`synchronously with ${inspect(options)}`, () => {
      let errInflate;
      // eslint-disable-next-line no-new
      try { new Decompress(options); } catch (err) { errInflate = err; }
      assert(errInflate);

      let errAuto;
      try {
        InflateAuto.inflateAutoSync(compressed, options);
      } catch (err) {
        errAuto = err;
      }

      assert.deepStrictEqual(errAuto, errInflate);
    });

    it(`on write with ${inspect(options)}`, () => {
      let errInflate;
      // eslint-disable-next-line no-new
      try { new Decompress(options); } catch (err) { errInflate = err; }
      assert(errInflate);

      return assertWriteError(
        new InflateAuto(options),
        compressed,
        (errAuto) => assert.deepStrictEqual(errAuto, errInflate),
      );
    });

    // Test handling in _flush
    it(`on end with ${inspect(options)}`, (done) => {
      let errInflate;
      // eslint-disable-next-line no-new
      try { new Decompress(options); } catch (err) { errInflate = err; }
      assert(errInflate);

      const inflateAuto = new InflateAuto({
        ...options,
        defaultFormat: Decompress,
      });
      let errorEmitted = false;
      inflateAuto.on('error', (errAuto) => {
        assert(!errorEmitted, 'error emitted at most once');
        errorEmitted = true;
        assert.deepStrictEqual(errAuto, errInflate);
      });
      inflateAuto.end((errAuto) => {
        assert(errorEmitted, 'error emitted at least once');
        // Errors passed to _flush callback may not be passed to end cb.
        if (errAuto) {
          assert.deepStrictEqual(errAuto, errInflate);
        }
        done();
      });
    });
  }

  describe('Constructor', () => {
    describe('validates', () => {
      // ZlibBase added in:
      // nodejs/node@3b9e0f2a0a9 for v12.0.0
      // nodejs/node@e534dcd75eb for v11.7.0
      // nodejs/node@dd8d1dabd7e for v10.16.0
      // Copying code to validate parameters without ZlibBase doesn't appear
      // to have a good cost/benefit tradeoff.  Skip until justified.
      if (nodeVersion[0] < 10
        || (nodeVersion[0] === 10 && nodeVersion[1] < 16)
        || (nodeVersion[0] === 11 && nodeVersion[1] < 7)) {
        before(function() { this.skip(); });
      }

      // Test each of the Errors thrown by ZlibBase for good measure
      itValidatesOptions({ chunkSize: zlib.Z_MIN_CHUNK - 1 });
      itValidatesOptions({ chunkSize: NaN });
      itValidatesOptions({ flush: -1 });
      itValidatesOptions({ finishFlush: -1 });
    });

    describe('emits error', () => {
      itEmitsErrorForOptions({ dictionary: true });
      itEmitsErrorForOptions({ level: zlib.Z_MIN_LEVEL - 1 });
      itEmitsErrorForOptions({ memLevel: zlib.Z_MIN_MEMLEVEL - 1 });
      itEmitsErrorForOptions({ strategy: -1 });
      itEmitsErrorForOptions({ windowBits: zlib.Z_MIN_WINDOWBITS - 1 });
    });

    it('supports chunkSize', () => {
      const options = { chunkSize: zlib.Z_MIN_CHUNK };
      const zlibStream = new Decompress(options);
      const inflateAuto = new InflateAuto(options);
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end(largeCompressed);
      inflateAuto.end(largeCompressed);
      return result;
    });

    it('supports finishFlush', () => {
      const options = { finishFlush: zlib.Z_SYNC_FLUSH };
      const zlibStream = new Decompress(options);
      const inflateAuto = new InflateAuto(options);
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      const truncated = largeCompressed.slice(0, -1);
      zlibStream.end(truncated);
      inflateAuto.end(truncated);
      return result;
    });
  });

  describe('#close()', () => {
    it('without writing', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      return new Promise((resolve, reject) => {
        zlibStream.close((...zlibArgs) => {
          inflateAuto.close((...inflateArgs) => {
            try {
              // Before nodejs/node#32220 (v14) an error is not passed.
              // Not worth the effort to match this behavior.  Always error.
              if (zlibArgs[0] === undefined) {
                assert.deepStrictEqual(
                  inflateArgs.slice(1),
                  zlibArgs.slice(1),
                  'same non-err close arguments',
                );
                assertInstanceOf(inflateArgs[0], Error);
                assert.deepStrictEqual(
                  inflateArgs[0].code,
                  'ERR_STREAM_PREMATURE_CLOSE',
                );
              } else {
                assert.deepStrictEqual(
                  inflateArgs,
                  zlibArgs,
                  'same close arguments',
                );
              }

              resolve(result);
            } catch (errAssert) {
              reject(errAssert);
            }
          });
        });
      });
    });

    // Zlib behavior changed in 8b43d3f5 (6.0.0) to emit on every call.
    // InflateAuto implements the earlier behavior.
    it('emits once for multiple calls', () => {
      const inflateAuto = new InflateAuto();

      let closeEmitted = false;
      inflateAuto.on('close', () => {
        assert.strictEqual(closeEmitted, false);
        closeEmitted = true;
      });

      inflateAuto.once('close', () => {
        inflateAuto.close();
      });

      inflateAuto.close();
      inflateAuto.close();

      return new Promise((resolve, reject) => {
        setImmediate(() => {
          assert.strictEqual(closeEmitted, true);
          resolve();
        });
      });
    });

    it('before #end()', () => {
      const zlibStream = new zlib.Inflate();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.close();
      inflateAuto.close();
      result.checkpoint();

      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();

      return result;
    });

    it('#reset() after #close()', () => {
      const zlibStream = new zlib.Inflate();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.close();
      inflateAuto.close();
      result.checkpoint();

      let errInflate;
      try { zlibStream.reset(); } catch (err) { errInflate = err; }
      let errAuto;
      try { inflateAuto.reset(); } catch (err) { errAuto = err; }

      // nodejs/node@6441556 (v6.2.1) changed the assertion to check _handle
      // which is null rather than false in this case.
      //
      // nodejs/node#25956 (v12) changed from ERR_ASSERTION to
      // ERR_INTERNAL_ASSERTION.
      //
      // It's not worth complicating the code to mimic this.
      assert.deepStrictEqual(
        errAuto instanceof Error,
        errInflate instanceof Error,
      );

      return result;
    });

    it('#write() after #close()', () => {
      const zlibStream = new zlib.Inflate();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.close();
      inflateAuto.close();
      result.checkpoint();

      return new Promise((resolve, reject) => {
        const writeArgsByCall = [];
        function onWrite(...writeArgs) {
          writeArgsByCall.push(writeArgs);
          if (writeArgsByCall.length === 2) {
            assert.deepStrictEqual(writeArgsByCall[0], writeArgsByCall[1]);
            resolve(result);
          }
        }

        zlibStream.write(Buffer.alloc(0), onWrite);
        inflateAuto.write(Buffer.alloc(0), onWrite);
        result.checkpoint();
      });
    });

    it('errors for non-function truthy argument type', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      let errInflate;
      try { zlibStream.close(true); } catch (err) { errInflate = err; }
      let errAuto;
      try { inflateAuto.close(true); } catch (err) { errAuto = err; }

      // In nodejs/node#32220 the error changed from ERR_INVALID_CALLBACK
      // to ERR_INVALID_ARG_TYPE (due to calling finished instead of nextTick).
      // It's not currently worth complicating the code to mimic this.
      if (errInflate && errInflate.code === 'ERR_INVALID_CALLBACK') {
        assert.deepStrictEqual(errAuto, errInflate);
      } else {
        assert.deepStrictEqual(
          errAuto instanceof Error,
          errInflate instanceof Error,
        );
      }

      // Streams may not emit any events.
      // End comparison after event queue clears.
      setImmediate(() => result.end());
      return result;
    });

    it('errors for non-undefined/null falsey argument type', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      let errInflate;
      try { zlibStream.close(false); } catch (err) { errInflate = err; }
      let errAuto;
      try { inflateAuto.close(false); } catch (err) { errAuto = err; }

      assert.deepStrictEqual(errAuto, errInflate);

      // Streams may not emit any events.
      // End comparison after event queue clears.
      setImmediate(() => result.end());
      return result;
    });
  });

  describe('#getFormat()', () => {
    it('returns format set by #setFormat()', () => {
      const inflateAuto = new InflateAuto();
      inflateAuto.setFormat(Decompress);
      assert.strictEqual(inflateAuto.getFormat(), Decompress);
    });

    function MyDecompress(...args) {
      Decompress.apply(this, args);
    }
    // Note:  MyDecompress.prototype.constructor intentionally not set
    MyDecompress.prototype = Object.create(Decompress.prototype);

    it('returns custom format set by #setFormat()', () => {
      const inflateAuto = new InflateAuto();
      inflateAuto.setFormat(MyDecompress);
      assert.strictEqual(inflateAuto.getFormat(), MyDecompress);
    });

    it('returns the detected format', (done) => {
      const inflateAuto = new InflateAuto();
      inflateAuto.on('format', () => {
        assert.strictEqual(inflateAuto.getFormat(), Decompress);
        done();
      });
      inflateAuto.write(compressed);
    });
  });

  describe('#flush()', () => {
    it('before write', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.flush();
      inflateAuto.flush();
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    // This behavior changed in node v5 and later due to
    // https://github.com/nodejs/node/pull/2595
    it('Z_FINISH before write', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.flush(zlib.Z_FINISH);
      inflateAuto.flush(zlib.Z_FINISH);
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    it('between writes', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.write(compressed.slice(0, 4));
      inflateAuto.write(compressed.slice(0, 4));
      result.checkpoint();

      zlibStream.flush();
      inflateAuto.flush();
      result.checkpoint();

      zlibStream.end(compressed.slice(4));
      inflateAuto.end(compressed.slice(4));
      result.checkpoint();

      return result;
    });

    // This behavior changed in node v5 and later due to
    // https://github.com/nodejs/node/pull/2595
    it('Z_FINISH between writes', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.write(compressed.slice(0, 4));
      inflateAuto.write(compressed.slice(0, 4));
      result.checkpoint();

      zlibStream.flush(zlib.Z_FINISH);
      inflateAuto.flush(zlib.Z_FINISH);
      result.checkpoint();

      zlibStream.end(compressed.slice(4));
      inflateAuto.end(compressed.slice(4));
      result.checkpoint();

      return result;
    });
  });

  describe('#params()', () => {
    // existence check
    it('has the same type', () => {
      let autoType = typeof InflateAuto.prototype.params;
      let zlibType = typeof Decompress.prototype.params;
      assert.strictEqual(autoType, zlibType);

      autoType = typeof new InflateAuto().params;
      zlibType = typeof new Decompress().params;
      assert.strictEqual(autoType, zlibType);
    });

    if (!Decompress.prototype.params) {
      return;
    }

    // Note:  Params have no effect on inflate, but calling .params() has
    // effects due to 0-byte Z_FINISH flush call.

    // FIXME: Calling .params() immediately before or after .write()/.end()
    // can have differing behavior between InflateAuto and Zlib because the
    // write queue is held in Zlib and because Zlib._transform() cheats and
    // checks ._writableState and sets Z_FINISH before ._flush() is called.
    // So .write(chunk) .end() has different behavior from .end(chunk) when
    // the write is buffered. (e.g. .params() .end(chunk)).
    //
    // This appears as "unexpected end of file" error when .end() is called
    // immediately after .params() due to Z_FINISH flush type being set on
    // empty write.
    //
    // This can't be fixed without abusing stream.Transform (e.g. by calling
    // _decoder.end() from this.end() before this._flush()).  Since this is
    // an edge case without known use cases, delay this risky fix for now.

    it('before write', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      const level = zlib.Z_BEST_COMPRESSION;
      const strategy = zlib.Z_FILTERED;
      zlibStream.params(level, strategy, (err) => {
        assert.ifError(err);
        zlibStream.end(compressed);
      });
      inflateAuto.params(level, strategy, (err) => {
        assert.ifError(err);
        inflateAuto.end(compressed);
      });
      result.checkpoint();

      return result;
    });

    it('between writes', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      const zlibWriteP = promisify(zlibStream.write);
      const autoWriteP = promisify(inflateAuto.write);

      const partial = compressed.slice(0, 4);
      return Promise.all([
        zlibWriteP.call(zlibStream, partial),
        autoWriteP.call(inflateAuto, partial),
      ]).then(() => {
        result.checkpoint();

        const remainder = compressed.slice(4);

        zlibStream.params(
          zlib.Z_BEST_COMPRESSION,
          zlib.Z_FILTERED,
          (err) => {
            assert.ifError(err);
            zlibStream.end(remainder);
          },
        );
        inflateAuto.params(
          zlib.Z_BEST_COMPRESSION,
          zlib.Z_FILTERED,
          (err) => {
            assert.ifError(err);
            inflateAuto.end(remainder);
          },
        );
        result.checkpoint();

        return result;
      });
    });

    // Zlib causes uncaughtException for params after close, so skip testing
    // after end.

    // Note:  Argument errors behavior is not guaranteed.  See method
    // comment for details.
  });

  describe('#reset()', () => {
    it('before write', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.reset();
      inflateAuto.reset();
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    if (headerLen > 0) {
      it('discards partial header', () => {
        const zlibStream = new Decompress();
        const inflateAuto = new InflateAuto();
        const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

        const dataAuto = [];
        inflateAuto.on('data', (data) => {
          dataAuto.push(data);
        });

        const zlibWriteP = promisify(zlibStream.write);
        const autoWriteP = promisify(inflateAuto.write);

        const partial = compressed.slice(0, 1);
        return Promise.all([
          zlibWriteP.call(zlibStream, partial),
          autoWriteP.call(inflateAuto, partial),
        ]).then(() => {
          result.checkpoint();

          // IMPORTANT:  Can't call Zlib.reset() with write in progress
          // Since write is run from uv work queue thread and reset from main
          zlibStream.reset();
          inflateAuto.reset();
          result.checkpoint();

          zlibStream.end(compressed);
          inflateAuto.end(compressed);
          result.checkpoint();

          // Gunzip gained reset in v6.0.0
          // https://github.com/nodejs/node/commit/f380db23
          // If zlib stream emits a header error, test for success instead of ==
          return new Promise((resolve, reject) => {
            let headerError = false;
            zlibStream.once('error', (err) => {
              if (err.message === 'incorrect header check') {
                headerError = true;
                // Comparison result ignored.  Suppress unhandled rejection.
                result.catch((errResult) => {});
              }
            });
            zlibStream.once('end', () => {
              resolve(result);
            });

            inflateAuto.once('end', () => {
              assert.deepStrictEqual(Buffer.concat(dataAuto), uncompressed);
              if (headerError) {
                resolve();
              }
            });
          });
        });
      });

      it('forgets partial header', () => {
        const zlibStream = new Decompress();
        const inflateAuto = new InflateAuto();
        const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

        // Note:  Only write to inflateAuto since zlib stream could error on
        // first byte due to invalid header.
        const autoWriteP = promisify(inflateAuto.write);

        // Write data with a different header before reset to check that reset
        // clears any partial-header state.
        return autoWriteP.call(inflateAuto, otherCompressed.slice(0, 1))
          .then(() => {
            // IMPORTANT:  Can't call Zlib.reset() with write in progress
            // Since write is run from uv work queue thread and reset from main
            zlibStream.reset();
            inflateAuto.reset();
            result.checkpoint();

            zlibStream.end(compressed);
            inflateAuto.end(compressed);
            result.checkpoint();

            return result;
          });
      });
    }

    it('discards post-header data', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      const zlibWriteP = promisify(zlibStream.write);
      const autoWriteP = promisify(inflateAuto.write);

      const partial = compressed.slice(0, headerLen + 1);
      return Promise.all([
        zlibWriteP.call(zlibStream, partial),
        autoWriteP.call(inflateAuto, partial),
      ]).then(() => {
        result.checkpoint();

        // IMPORTANT:  Can't call Zlib.reset() with write in progress
        // Since write is run from uv work queue thread and reset from main
        zlibStream.reset();
        inflateAuto.reset();
        result.checkpoint();

        zlibStream.end(compressed);
        inflateAuto.end(compressed);
        result.checkpoint();

        return result;
      });
    });

    // Note:  Behavior on compression type change after reset is not
    // guaranteed.  See method comment for details.
  });

  describe('#setEncoding()', () => {
    it('behaves the same before writes', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.setEncoding('utf8');
      inflateAuto.setEncoding('utf8');
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    it('behaves the same after format', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      const zlibWriteP = promisify(zlibStream.write);
      const autoWriteP = promisify(inflateAuto.write);

      const chunk = compressed.slice(0, headerLen + 4);
      return Promise.all([
        zlibWriteP.call(zlibStream, chunk),
        autoWriteP.call(inflateAuto, chunk),
      ]).then(() => {
        result.checkpoint();

        zlibStream.setEncoding('utf8');
        inflateAuto.setEncoding('utf8');
        result.checkpoint();

        const rest = compressed.slice(chunk.length);
        zlibStream.end(rest);
        inflateAuto.end(rest);
        result.checkpoint();

        return result;
      });
    });
  });

  describe('#setFormat()', () => {
    it('emits \'format\' event with decoder', () => {
      const inflateAuto = new InflateAuto();
      let gotFormat = false;
      inflateAuto.on('format', (decoder) => {
        assert(decoder instanceof Decompress);
        gotFormat = true;
      });
      inflateAuto.setFormat(Decompress);
      assert.strictEqual(gotFormat, true);
    });

    it('can set correct format before write', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      inflateAuto.setFormat(Decompress);
      result.checkpoint();
      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();
      return result;
    });

    it('can set incorrect format before write', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      inflateAuto.setFormat(Decompress);
      result.checkpoint();
      zlibStream.end(otherCompressed);
      inflateAuto.end(otherCompressed);
      result.checkpoint();
      return result;
    });

    it('can set same format twice', () => {
      const zlibStream = new Decompress();
      const inflateAuto = new InflateAuto();
      const result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      inflateAuto.setFormat(Decompress);
      inflateAuto.setFormat(Decompress);
      result.checkpoint();
      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();
      return result;
    });

    it('throws if changing format', () => {
      const inflateAuto = new InflateAuto();
      inflateAuto.setFormat(zlib.Inflate);
      try {
        inflateAuto.setFormat(zlib.Gunzip);
        throw new Error('Should have thrown');
      } catch (err) {
        assert(/\bformat\b/i.test(err.message));
      }
    });

    it('throws if changing detected format', () => {
      const inflateAuto = new InflateAuto();
      inflateAuto.write(otherHeader);
      try {
        inflateAuto.setFormat(Decompress);
        throw new Error('Should have thrown');
      } catch (err) {
        assert(/\bformat\b/i.test(err.message));
      }
    });
  });

  // _processChunk is a semi-public API since it is called externally for
  // synchronous operation.  Other code may rely on this.
  describe('#_processChunk()', () => {
    // existence check
    it('has the same type', () => {
      let autoType = typeof InflateAuto.prototype._processChunk;
      let zlibType = typeof Decompress.prototype._processChunk;
      assert.strictEqual(autoType, zlibType);

      autoType = typeof new InflateAuto()._processChunk;
      zlibType = typeof new Decompress()._processChunk;
      assert.strictEqual(autoType, zlibType);
    });

    if (!Decompress.prototype._processChunk) {
      return;
    }

    describe('with cb', () => {
      // Note:  When called with callback without 'error' listener on 0.12
      // 'error' is emitted asynchronously causing unhandledException.
      // Not currently tested.

      if (isDefaultFormat) {
        it('emits error without calling callback', () => {
          const zlibStream = new Decompress();
          const inflateAuto = new InflateAuto();
          const result =
            streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

          const zeros = Buffer.alloc(10);
          zlibStream._processChunk(zeros, zlib.Z_FINISH, neverCalled);
          inflateAuto._processChunk(zeros, zlib.Z_FINISH, neverCalled);
          result.checkpoint();
          return result;
        });

        it('yields format error', (done) => {
          const inflateAuto = new InflateAuto({ defaultFormat: null });
          const zeros = Buffer.alloc(10);
          inflateAuto.on('error', () => {
            throw new Error('error should not be emitted');
          });
          inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH, (err) => {
            assert(err, 'expected format error');
            assert(/format/i.test(err.message));
            assert.deepStrictEqual(err.data, zeros);
            done();
          });
        });
      }

      it('works if _transform does not yield synchronously', (done) => {
        function AsyncTransform(...args) { stream.Transform.apply(this, args); }
        AsyncTransform.prototype = Object.create(stream.Transform.prototype);
        AsyncTransform.prototype.constructor = AsyncTransform;
        AsyncTransform.prototype._transform = function(data, enc, cb) {
          process.nextTick(() => {
            cb(null, data);
          });
        };

        const inflateAuto = new InflateAuto({ defaultFormat: AsyncTransform });
        const zeros = Buffer.alloc(10);
        inflateAuto.on('error', () => {
          throw new Error('error should not be emitted');
        });
        inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH, (err, data) => {
          assert.deepStrictEqual(data, zeros);
          done();
        });
      });

      it('buffers inconclusive data', (done) => {
        const inflateAuto = new InflateAuto();
        const trunc = compressed.slice(0, 1);
        inflateAuto.on('error', () => {
          throw new Error('error should not be emitted');
        });
        inflateAuto._processChunk(trunc, zlib.Z_NO_FLUSH, (err, data) => {
          assert.ifError(err);
          assert.strictEqual(data, undefined);
          done();
        });
      });
    });

    describe('without cb', () => {
      if (isDefaultFormat) {
        it('throws without error listener', () => {
          const zlibStream = new Decompress();
          const inflateAuto = new InflateAuto();

          const zeros = Buffer.alloc(10);

          let errInflate;
          try {
            zlibStream._processChunk(zeros, zlib.Z_FINISH);
          } catch (err) {
            errInflate = err;
          }

          let errAuto;
          try {
            inflateAuto._processChunk(zeros, zlib.Z_FINISH);
          } catch (err) {
            errAuto = err;
          }

          assert.deepStrictEqual(errAuto, errInflate);
        });

        it('throws with error listener', () => {
          const zlibStream = new Decompress();
          const inflateAuto = new InflateAuto();
          const result =
            streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

          const zeros = Buffer.alloc(10);

          let errInflate;
          try {
            zlibStream._processChunk(zeros, zlib.Z_FINISH);
          } catch (err) {
            errInflate = err;
          }

          let errAuto;
          try {
            inflateAuto._processChunk(zeros, zlib.Z_FINISH);
          } catch (err) {
            errAuto = err;
          }

          assert.deepStrictEqual(errAuto, errInflate);
          result.checkpoint();
        });

        it('throws format errors', () => {
          const inflateAuto = new InflateAuto({ defaultFormat: null });
          const zeros = Buffer.alloc(10);
          inflateAuto.on('error', () => {
            throw new Error('error should not be emitted');
          });
          assert.throws(() => {
            inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH);
          });
        });
      }

      it('throws if format lacks _processChunk and _transform', () => {
        function NoTransform(...args) { stream.Duplex.apply(this, args); }
        NoTransform.prototype = Object.create(stream.Duplex.prototype);
        NoTransform.prototype.constructor = NoTransform;
        NoTransform.prototype._read = function() {};
        NoTransform.prototype._write = function(chunk, enc, cb) {
          this.push(chunk);
          cb();
        };

        const inflateAuto = new InflateAuto({ defaultFormat: NoTransform });
        const zeros = Buffer.alloc(10);
        inflateAuto.on('error', () => {
          throw new Error('error should not be emitted');
        });
        assert.throws(
          () => inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH),
          (err) => {
            assert(err instanceof Error);
            assert.strictEqual(err.code, 'ERR_SYNC_NOT_SUPPORTED');
            return true;
          },
        );
      });

      it('throws if _transform does not yield synchronously', () => {
        function AsyncTransform(...args) { stream.Transform.apply(this, args); }
        AsyncTransform.prototype = Object.create(stream.Transform.prototype);
        AsyncTransform.prototype.constructor = AsyncTransform;
        AsyncTransform.prototype._transform = function() {};

        const inflateAuto = new InflateAuto({ defaultFormat: AsyncTransform });
        const zeros = Buffer.alloc(10);
        inflateAuto.on('error', () => {
          throw new Error('error should not be emitted');
        });
        assert.throws(
          () => inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH),
          (err) => {
            assert(err instanceof Error);
            assert.strictEqual(err.code, 'ERR_SYNC_NOT_SUPPORTED');
            return true;
          },
        );
      });

      it('throws if _transform yields Error', () => {
        const errTest = new Error('test');
        function ErrorTransform(...args) { stream.Transform.apply(this, args); }
        ErrorTransform.prototype = Object.create(stream.Transform.prototype);
        ErrorTransform.prototype.constructor = ErrorTransform;
        ErrorTransform.prototype._transform = function(data, enc, cb) {
          cb(errTest);
        };

        const inflateAuto = new InflateAuto({ defaultFormat: ErrorTransform });
        const zeros = Buffer.alloc(10);
        inflateAuto.on('error', () => {
          throw new Error('error should not be emitted');
        });
        assert.throws(
          () => {
            inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH);
          },
          (err) => err === errTest,
        );
      });

      it('supports non-Buffer TypedArray', () => {
        const compressedTA = new Uint8Array(compressed);
        const dataDecompress =
          new Decompress()._processChunk(compressedTA, zlib.Z_FINISH);
        const dataAuto =
          new InflateAuto()._processChunk(compressedTA, zlib.Z_FINISH);
        assert.deepStrictEqual(dataAuto, dataDecompress);
      });

      it('supports ArrayBuffer', () => {
        const compressedBuf = compressed.buffer.slice(
          compressed.byteOffset,
          compressed.byteOffset + compressed.length,
        );
        // As of Node v14, this would cause an assertion failure
        // Test that InflateAuto matches Buffer/TypedArray behavior
        const dataDecompress =
          new Decompress()._processChunk(compressed, zlib.Z_FINISH);
        const dataAuto =
          new InflateAuto()._processChunk(compressedBuf, zlib.Z_FINISH);
        assert.deepStrictEqual(dataAuto, dataDecompress);
      });

      it('throws for invalid chunk type', () => {
        // As of Node v14, this would cause an assertion failure
        // Test that InflateAuto throws TypeError
        assert.throws(
          () => new InflateAuto()._processChunk(10, zlib.Z_FINISH),
          TypeError,
        );
      });
    });
  });
}

describe('InflateAuto', () => {
  // Match constructor behavior of Gunzip/Inflate/InflateRaw
  it('instantiates without new', () => {
    // eslint-disable-next-line new-cap
    const auto = InflateAuto();
    assertInstanceOf(auto, InflateAuto);
  });

  it('accepts Array-like detectors', () => {
    const auto = new InflateAuto({
      detectors: {
        0: zlib.Gunzip,
        length: 1,
      },
    });
    assert.deepStrictEqual(auto._detectors, [zlib.Gunzip]);
  });

  it('throws TypeError for non-Array-like detectors', () => {
    assert.throws(
      // eslint-disable-next-line no-new
      () => { new InflateAuto({ detectors: true }); },
      TypeError,
    );
  });

  it('throws TypeError for non-function detector', () => {
    assert.throws(
      // eslint-disable-next-line no-new
      () => { new InflateAuto({ detectors: [zlib.Gunzip, null] }); },
      TypeError,
    );
  });

  it('throws TypeError for non-function defaultFormat', () => {
    assert.throws(
      // eslint-disable-next-line no-new
      () => { new InflateAuto({ defaultFormat: true }); },
      TypeError,
    );
  });

  it('defaultFormat null disables default', () => {
    const auto = new InflateAuto({ defaultFormat: null });
    const testData = Buffer.alloc(10);
    return assertWriteError(auto, testData, (err) => {
      assert(err, 'expected format mismatch error');
      assert(/format/i.test(err.message));
      assert.deepStrictEqual(err.data, testData);
    });
  });

  it('emits error for format detection error in _transform', () => {
    const inflateAuto = new InflateAuto({ defaultFormat: null });
    const zeros = Buffer.alloc(10);
    return assertWriteError(inflateAuto, zeros, (err) => {
      assert(err, 'expected format error');
      assert(/format/i.test(err.message));
      assert.deepStrictEqual(err.data, zeros);
    });
  });

  // Analogous to Gunzip/Inflate/InflateRaw
  describe('.createInflateAuto()', () => {
    it('is a factory function', () => {
      const auto = InflateAuto.createInflateAuto();
      assertInstanceOf(auto, InflateAuto);
    });
  });

  describe('#flush()', () => {
    // To prevent deadlocks of callers waiting for flush before writing
    it('calls its callback before format detection', (done) => {
      const auto = new InflateAuto();
      auto.on('error', done);
      auto.flush(done);
    });
  });

  describe('#getFormat()', () => {
    it('returns null before format detection', () => {
      const inflateAuto = new InflateAuto();
      assert.strictEqual(inflateAuto.getFormat(), null);
    });
  });

  if (InflateAuto.prototype.params) {
    describe('#params()', () => {
      // To prevent deadlocks of callers waiting for params before writing
      it('calls its callback before format detection', (done) => {
        const auto = new InflateAuto();
        auto.on('error', done);
        auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED, done);
      });
    });
  }

  SUPPORTED_FORMATS.forEach((format) => {
    describe(`${format.Compress.name} support`, () => {
      defineFormatTests(format);
    });
  });
});

/**
 * @copyright Copyright 2016 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */
'use strict';

// Test writing null
// Test writing 0 bytes
// Test writing 1 byte
// Test writing 2 bytes (deflate, gzip, and raw)
// Test writing 3 bytes (deflate, gzip, and raw)
// Test each of the above followed by close
// Test each of the above followed by another write
// Test corrupted data for deflate, gzip, and raw
// Check close, flush, params, reset method functionality
// Check close, flush, params, reset work when called before write

// Test constructor options
// Test {flush: zlib.Z_BLOCK} option match (doesn't output for 4-byte write)

// Create StreamCompare class and refactor tests to use it

const Buffer = require('buffer').Buffer;
const InflateAuto = require('..');
const should = require('should');
const zlib = require('zlib');

// Note:  compressedData and uncompressedData are added before tests are run
const SUPPORTED_FORMATS = [
  {
    compress: zlib.gzip,
    compressStream: zlib.Gzip,
    compressSync: zlib.gzipSync,
    decompress: zlib.gunzip,
    decompressStream: zlib.Gunzip,
    decompressSync: zlib.gunzipSync,
    headerLen: 3
  },
  {
    compress: zlib.deflate,
    compressStream: zlib.Deflate,
    compressSync: zlib.deflateSync,
    decompress: zlib.inflate,
    decompressStream: zlib.Inflate,
    decompressSync: zlib.inflateSync,
    headerLen: 2
  },
  {
    compress: zlib.deflateRaw,
    compressStream: zlib.DeflateRaw,
    compressSync: zlib.deflateRawSync,
    decompress: zlib.inflateRaw,
    decompressStream: zlib.InflateRaw,
    decompressSync: zlib.inflateRawSync,
    headerLen: 0
  }
];

const TEST_DATA = {
  empty: new Buffer(0),
  // 'normal' is the default for not-data-specific tests
  normal: new Buffer('uncompressed data')
};

/** Inflate data by writing blocks of a given size. */
function inflateBlocks(compressed, blocksize, cb) {
  var auto = new InflateAuto();
  auto.on('error', cb);

  var output = [];
  auto.on('data', function(data) {
    output.push(data);
  });
  auto.on('end', function() {
    cb(null, Buffer.concat(output));
  });

  for (var i = 0; i < compressed.length; i += blocksize) {
    auto.write(compressed.slice(i, i + blocksize)).should.be.true();
  }
  auto.end();
}

/** Defines tests which are run for a given format and named data. */
function defineFormatDataTests(format, dataName) {
  var compressed = format.compressedData[dataName];
  var uncompressed = format.uncompressedData[dataName];

  it('works for ' + dataName + ' data', function(done) {
    InflateAuto.inflateAuto(compressed, function(errAuto, output) {
      should.ifError(errAuto);

      should.deepEqual(output, uncompressed);
      done();
    });
  });

  it('works for ' + dataName + ' data - 1 byte writes', function(done) {
    inflateBlocks(compressed, 1, function(errAuto, output) {
      should.ifError(errAuto);
      should.deepEqual(output, uncompressed);
      done();
    });
  });

  it('works for ' + dataName + ' data synchronously', function(done) {
    var inflated = InflateAuto.inflateAutoSync(compressed);
    should.deepEqual(inflated, uncompressed);
    done();
  });
}

/** Defines tests which are run for a given format. */
function defineFormatTests(format) {
  Object.keys(format.compressedData).forEach(function(dataName) {
    defineFormatDataTests(format, dataName);
  });

  var compressed = format.compressedData.normal;
  var uncompressed = format.uncompressedData.normal;

  var compress = format.compress;
  var decompress = format.decompress;

  // This behavior changed in node v5 and later due to
  // https://github.com/nodejs/node/pull/2595
  it('handles truncated data', function(done) {
    // Truncate shortly after the header (if any) for type detection
    var truncated = compressed.slice(0, format.headerLen + 1);
    decompress(truncated, function(errInflate, dataInflate) {
      InflateAuto.inflateAuto(truncated, function(errAuto, dataAuto) {
        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
        done();
      });
    });
  });

  it('handles corrupted data', function(done) {
    var zeroed = new Buffer(compressed);
    // Leave signature intact
    zeroed.fill(0, format.headerLen);
    decompress(zeroed, function(errInflate, dataInflate) {
      InflateAuto.inflateAuto(zeroed, function(errAuto, dataAuto) {
        should.exist(errInflate);
        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
        done();
      });
    });
  });

  it('handles missing dictionary', function(done) {
    var options = {dictionary: uncompressed};
    compress(uncompressed, options, function(err, compressedDict) {
      should.ifError(err);

      decompress(compressedDict, function(errInflate, dataInflate) {
        InflateAuto.inflateAuto(compressedDict, function(errAuto, dataAuto) {
          should.deepEqual(errInflate, errAuto);
          should.deepEqual(dataInflate, dataAuto);
          done();
        });
      });
    });
  });
}

/** Defines tests for a given set of supported formats. */
function defineTests(formats) {
  describe('InflateAuto', function() {
    // Match constructor behavior of Gunzip/Inflate/InflateRaw
    it('instantiates without new', function() {
      var auto = InflateAuto();
      should(auto).be.instanceof(InflateAuto);
    });

    it('behaves like InflateRaw for no data', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.end(done);
    });

    it('supports writing no data', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.end(new Buffer(0), done);
    });

    it('treats partial zlib header as raw', function(done) {
      var partial = new Buffer([0x78]);
      zlib.inflateRaw(partial, function(errInflate, dataInflate) {
        InflateAuto.inflateAuto(partial, function(errAuto, dataAuto) {
          should.deepEqual(errInflate, errAuto);
          should.deepEqual(dataInflate, dataAuto);
          done();
        });
      });
    });

    it('treats partial gzip header as raw', function(done) {
      var partial = new Buffer([0x1f]);
      zlib.inflateRaw(partial, function(errInflate, dataInflate) {
        InflateAuto.inflateAuto(partial, function(errAuto, dataAuto) {
          should.deepEqual(errInflate, errAuto);
          should.deepEqual(dataInflate, dataAuto);
          done();
        });
      });
    });

    it('behaves like Inflate for incorrect checksum', function(done) {
      var compressed = formats[1].compressedData.normal;
      var invalid = new Buffer(compressed);
      invalid[invalid.length - 1] = invalid[invalid.length - 1] ^ 0x1;
      zlib.inflate(invalid, function(errInflate, dataInflate) {
        InflateAuto.inflateAuto(invalid, function(errAuto, dataAuto) {
          should.deepEqual(errInflate, errAuto);
          should.deepEqual(dataInflate, dataAuto);
          done();
        });
      });
    });

    // For objectMode: true validation is done in _transform.  Check we match.
    it('errors on write of invalid type', function(done) {
      var inflate = new zlib.Inflate({objectMode: true});
      var haveErr1 = false;
      inflate.on('error', function(errInflate) {
        var auto = new InflateAuto({objectMode: true});
        var haveErr2 = false;
        auto.on('error', function(errAuto) {
          should.deepEqual(errInflate, errAuto);
          done();
        });
        auto.on('end', function() {
          haveErr2.should.be.true();
        });

        auto.write(true);
        auto.end();
      });
      inflate.on('end', function() {
        haveErr1.should.be.true();
      });

      inflate.write(true);
      inflate.end();
    });

    // Analogous to Gunzip/Inflate/InflateRaw
    describe('.createInflateAuto()', function() {
      it('is a factory function', function() {
        var auto = InflateAuto.createInflateAuto();
        should(auto).be.instanceof(InflateAuto);
      });
    });

    describe('.inflateAutoSync()', function() {
      it('can inflate strings synchronously', function() {
        var uncompressed = new Buffer([0]);
        // Note:  deflateSync is invalid UTF-8.  deflateRawSync is ok.
        var compressed = zlib.deflateRawSync(uncompressed);
        var inflated = InflateAuto.inflateAutoSync(compressed.toString());
        should.deepEqual(inflated, uncompressed);
      });

      it('errors like Inflate for invalid type synchronously', function() {
        var errInflate;
        try {
          zlib.inflateSync(true);
        } catch (err) {
          errInflate = err;
        }

        var errAuto;
        try {
          InflateAuto.inflateAutoSync(true);
        } catch (err) {
          errAuto = err;
        }

        should.exist(errInflate);
        should.deepEqual(errInflate, errAuto);
      });

      it('errors like InflateRaw for partial zlib header', function() {
        var partial = new Buffer([0x78]);

        var dataInflate, errInflate;
        try {
          dataInflate = zlib.inflateRawSync(partial);
        } catch (err) {
          errInflate = err;
        }

        var dataAuto, errAuto;
        try {
          dataAuto = InflateAuto.inflateAutoSync(partial);
        } catch (err) {
          errAuto = err;
        }

        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
      });
    });

    describe('#close()', function() {
      it('calls its callback immediately', function(done) {
        var auto = new InflateAuto();
        auto.on('error', done);
        auto.close(done);
      });

      it('emits the close event', function(done) {
        var auto = new InflateAuto();
        auto.on('error', done);
        auto.on('close', done);
        auto.close();
      });

      it('only emits the close event once', function(done) {
        var auto = new InflateAuto();
        auto.on('error', done);
        var closeCount = 0;
        auto.on('close', function() {
          ++closeCount;
          closeCount.should.equal(1);
          auto.close();
          setTimeout(done, 1);
        });
        auto.close();
      });

      it('emits error on #end() after #close()', function(done) {
        var auto = new InflateAuto();
        var inflate = new zlib.Inflate();

        var autoErr;
        var inflateErr;
        function oneDone(err) {
          if (this === auto) {
            autoErr = err || false;
          } else {
            inflateErr = err || false;
          }

          if (autoErr !== undefined && inflateErr !== undefined) {
            should.deepEqual(autoErr, inflateErr);
            done();
          }
        }

        inflate.on('error', oneDone);
        inflate.on('end', oneDone);
        inflate.close();
        inflate.end(function(inflateErr2) {
          auto.on('error', oneDone);
          auto.on('end', oneDone);
          auto.close();
          auto.end(function(autoErr2) {
            should.deepEqual(inflateErr2, autoErr2);
          });
        });
      });

      it('throws on #reset() after #close()', function(done) {
        var inflate = new zlib.Inflate();
        inflate.on('error', done);
        inflate.close();
        var errInflate;
        try { inflate.reset(); } catch (err) { errInflate = err; }

        var auto = new InflateAuto();
        auto.on('error', done);
        auto.close();
        var errAuto;
        try { auto.reset(); } catch (err) { errAuto = err; }

        should.deepEqual(errInflate, errAuto);
        // Wait for error event, if any
        setTimeout(done, 1);
      });

      it('returns error on #write() after #close()', function(done) {
        var auto = new InflateAuto();
        var inflate = new zlib.Inflate();

        var autoErr;
        var inflateErr;
        function oneDone(err) {
          if (this === auto) {
            autoErr = err || false;
          } else {
            inflateErr = err || false;
          }

          if (autoErr !== undefined && inflateErr !== undefined) {
            should.deepEqual(autoErr, inflateErr);
            done();
          }
        }

        inflate.on('error', oneDone);
        inflate.on('end', oneDone);
        inflate.close();
        inflate.write(new Buffer(0), function(inflateErr2) {
          should.exist(inflateErr2);

          auto.on('error', oneDone);
          auto.on('end', oneDone);
          auto.close();
          auto.write(new Buffer(0), function(autoErr2) {
            should.deepEqual(inflateErr2, autoErr2);
          });
        });
      });
    });

    describe('#flush()', function() {
      // To prevent deadlocks of callers waiting for flush before writing
      it('calls its callback immediately', function(done) {
        var auto = new InflateAuto();
        auto.on('error', done);
        auto.flush(done);
      });

      it('doesn\'t cause error before write', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.flush();
          auto.end(compressed);
        });
      });

      // This behavior changed in node v5 and later due to
      // https://github.com/nodejs/node/pull/2595
      it('behaves like Inflate for Z_FINISH before write', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.flush(zlib.Z_FINISH);
          auto.end(compressed);
        });
      });

      it('doesn\'t cause error between writes', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.write(compressed.slice(0, 4));
          auto.flush();
          auto.end(compressed.slice(4));
        });
      });

      // This behavior changed in node v5 and later due to
      // https://github.com/nodejs/node/pull/2595
      it('behaves like Inflate for Z_FINISH between writes', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(errDeflate, compressed) {
          should.ifError(errDeflate);

          var auto = new InflateAuto();
          var inflate = new zlib.Inflate();

          var autoOut = [];
          auto.on('data', function(data) {
            autoOut.push(data);
          });

          var inflateOut = [];
          inflate.on('data', function(data) {
            inflateOut.push(data);
          });

          var autoErr;
          var inflateErr;
          function oneDone(err) {
            if (this === auto) {
              autoErr = err || false;
            } else {
              inflateErr = err || false;
            }

            if (autoErr !== undefined && inflateErr !== undefined) {
              should.deepEqual(autoErr, inflateErr);
              should.deepEqual(autoOut, inflateOut);
              done();
            }
          }
          // Note:  May raise multiple errors (one for flush, one for end)
          auto.once('error', oneDone);
          inflate.once('error', oneDone);
          auto.on('end', oneDone);
          inflate.on('end', oneDone);

          auto.write(compressed.slice(0, 4));
          inflate.write(compressed.slice(0, 4));

          auto.flush(zlib.Z_FINISH);
          inflate.flush(zlib.Z_FINISH);

          auto.end(compressed.slice(4));
          inflate.end(compressed.slice(4));
        });
      });
    });

    describe('#params()', function() {
      // To prevent deadlocks of callers waiting for params before writing
      it('calls its callback immediately', function(done) {
        var auto = new InflateAuto();
        auto.on('error', done);
        auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED, done);
      });

      // Note:  Params has no effect on inflate.  Tested only to avoid errors.
      it('doesn\'t cause error before write', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED);
          auto.end(compressed);
        });
      });

      it('doesn\'t cause error between writes', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.write(compressed.slice(0, 4));
          auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED);
          auto.end(compressed.slice(4));
        });
      });

      // Note:  Argument errors behavior is not guaranteed.  See method comment
      // for details.
    });

    describe('#reset()', function() {
      it('does nothing pre-write', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.reset();
          auto.end(compressed);
        });
      });

      it('discards partial zlib header', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.write(compressed.slice(0, 1));
          auto.reset();
          auto.write(compressed);
          auto.end();
        });
      });

      it('discards post-zlib-header data', function(done) {
        var uncompressed = new Buffer([0]);
        zlib.deflate(uncompressed, function(err, compressed) {
          should.ifError(err);

          var auto = new InflateAuto();
          auto.on('error', done);

          var output = [];
          auto.on('data', function(data) {
            output.push(data);
          });
          auto.on('end', function() {
            should.deepEqual(Buffer.concat(output), uncompressed);
            done();
          });

          auto.write(compressed.slice(0, 3));
          auto.reset();
          auto.write(compressed);
          auto.end();
        });
      });

      // Note:  Behavior on compression type change after reset is not
      // guaranteed.  See method comment for details.
    });

    SUPPORTED_FORMATS.forEach(function(format) {
      describe(format.compressStream.name + ' support', function() {
        defineFormatTests(format);
      });
    });
  });
}

/** Compresses the values of a given object for a given format. */
function compressValues(format, namedData) {
  var dataNames = Object.keys(namedData);
  var compressedP = dataNames.map(function(dataName) {
    return new Promise(function(resolve, reject) {
      var data = namedData[dataName];
      format.compress(data, function(err, compressed) {
        if (err) {
          reject(err);
        } else {
          resolve(compressed);
        }
      });
    });
  });

  return Promise.all(compressedP)
    .then(function(compressed) {
      return dataNames.reduce(function(compressedByName, dataName, i) {
        compressedByName[dataName] = compressed[i];
        return compressedByName;
      }, {});
    });
}

/** Prepares a given format for testing (by pre-compressing data). */
function prepareFormat(format, testData) {
  return compressValues(format, testData)
    .then(function(compressedData) {
      format.compressedData = compressedData;
      format.uncompressedData = testData;
      return format;
    });
}

/** Prepares for testing (by pre-compressing data). */
function prepareTests(formats, testData) {
  return Promise.all(formats.map(function(format) {
    return prepareFormat(format, testData);
  }))
    .then(defineTests);
}

/** Called if an error occurs during test setup. */
function onSetupError(err) {
  console.error(err.stack);
  process.exit(1);
}

prepareTests(SUPPORTED_FORMATS, TEST_DATA).then(run, onSetupError);

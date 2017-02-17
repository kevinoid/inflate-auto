InflateAuto
===========

[![Build Status: Linux](https://img.shields.io/travis/kevinoid/inflate-auto.svg?style=flat-square&label=build+on+linux)](https://travis-ci.org/kevinoid/inflate-auto)
[![Build Status: Windows](https://img.shields.io/appveyor/ci/kevinoid/inflate-auto.svg?style=flat&label=build+on+windows)](https://ci.appveyor.com/project/kevinoid/inflate-auto)
[![Coverage](https://img.shields.io/codecov/c/github/kevinoid/inflate-auto.svg?style=flat-square)](https://codecov.io/github/kevinoid/inflate-auto?branch=master)
[![Dependency Status](https://img.shields.io/david/kevinoid/inflate-auto.svg?style=flat-square)](https://david-dm.org/kevinoid/inflate-auto)
[![Supported Node Version](https://img.shields.io/node/v/inflate-auto.svg?style=flat)](https://www.npmjs.com/package/inflate-auto)
[![Version on NPM](https://img.shields.io/npm/v/inflate-auto.svg?style=flat)](https://www.npmjs.com/package/inflate-auto)

The `InflateAuto` class is designed to function as a drop-in replacement for
`zlib.Gunzip`, `zlib.Inflate`, and `zlib.InflateRaw` when the method of
compression is not known in advance.  `InflateAuto` uses the first few bytes
of data to determine the compression method (by checking for a valid gzip or
zlib deflate header) then delegating the decompression work to the
corresponding type.


## Introductory Example

```js
const InflateAuto = require('inflate-auto');
const assert = require('assert');
const zlib = require('zlib');

const testData = new Buffer('example data');
const compressor = Math.random() < 0.33 ? zlib.deflate :
      Math.random() < 0.5 ? zlib.deflateRaw :
      zlib.gzip;
compressor(testData, (errCompress, compressed) => {
  assert.ifError(errCompress);

  InflateAuto.inflateAuto(compressed, function(errDecompress, decompressed) {
    assert.ifError(errDecompress);
    assert.deepStrictEqual(decompressed, testData);
    console.log('Data compressed with random format and auto-decompressed.');
  });
});
```


## Compatibility

`InflateAuto` should behave identically to any of the `zlib` decompression
types, with the exception of `instanceof` and `.constructor` checks.  Using
the class should be as simple as `s/Inflate\(Raw\)?/InflateAuto/g`
in existing code.  If any real-world which code requires modification (other
than mentioned above) to work with `InflateAuto` it is considered a bug in
`InflateAuto`.  Please [report any such
issues](https://github.com/kevinoid/inflate-auto/issues/new).


## Use Cases

The primary use case for which this module was created is decompressing HTTP
responses which declare `Content-Encoding: deflate`.  As noted in [Section
4.2.2 of RFC 7230](https://tools.ietf.org/html/rfc7230#section-4.2.2) "Some
non-conformant implementations send the `"deflate"` compressed data without
the zlib wrapper."  This has been attributed to [early Microsoft
servers](https://stackoverflow.com/a/9186091) and to [old Apache
mod\_deflate](https://mxr.mozilla.org/mozilla-esr38/source/netwerk/streamconv/converters/nsHTTPCompressConv.cpp#214),
and is almost certainly an issue in less common servers.  Regardless of the
most common cause, it is observed in real-world behavior and poses a
compatibility risk for HTTP clients which support deflate encoding.  Using
`InflateAuto` is one way to address the issue.


## Installation

[This package](https://www.npmjs.com/package/inflate-auto) can be installed
using [npm](https://www.npmjs.com/) by running:

```sh
npm install inflate-auto
```


## Recipes

### Deflate HTTP

Compressed HTTP/HTTPS responses can be supported with code similar to the
following:

```js
const InflateAuto = require('inflate-auto');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const options = url.parse('https://api.stackexchange.com/2.2/answers?order=desc&sort=activity&site=stackoverflow');
options.headers = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate'
};
https.get(options, function(res) {
  const encoding =
    (res.headers['content-encoding'] || 'identity').trim().toLowerCase();

  // InflateAuto could be used for gzip to accept deflate data declared as gzip
  const inflater = encoding === 'deflate' ? new InflateAuto() :
    encoding === 'gzip' ? new zlib.Gunzip() :
    null;

  var bodyData;
  if (inflater) {
    inflater.on('error', function(err) {
      console.error('Decompression error:', err);
    });
    bodyData = res.pipe(inflater);
  } else {
    bodyData = res;
  }

  bodyData.pipe(process.stdout, {end: false});
})
  .on('error', function(err) {
    console.error('Request error:', err);
  });
```

### Synchronous Inflate

Data can be decompressed while blocking the main thread using
`InflateAuto.inflateAutoSync` (analogously to `zlib.inflateSync`) as follows:

```js
const InflateAuto = require('inflate-auto');
const assert = require('assert');
const zlib = require('zlib');

const compressor = Math.random() < 0.33 ? zlib.deflateSync :
      Math.random() < 0.5 ? zlib.deflateRawSync :
      zlib.gzipSync;
const testData = new Buffer('example data');
const compressed = compressor(testData);
const decompressed = InflateAuto.inflateAutoSync(compressed);
assert.deepStrictEqual(decompressed, testData);
```

More examples can be found in the [test
specifications](https://kevinoid.github.io/inflate-auto/specs).


## API Docs

For the details of using this module as a library, see the [API
Documentation](https://kevinoid.github.io/inflate-auto/api).


## Contributing

Contributions are welcome and very much appreciated!  Please add tests to
cover any changes and ensure `npm test` passes.

If the desired change is large, complex, backwards-incompatible, can have
significantly differing implementations, or may not be in scope for this
project, opening an issue before writing the code can avoid frustration and
save a lot of time and effort.


## License

This package is available under the terms of the
[MIT License](https://opensource.org/licenses/MIT).

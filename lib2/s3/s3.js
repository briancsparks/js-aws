
/**
 *
 */
const sg                      = require('sgsg');
const _                       = sg._;
const raLib                   = sg.include('run-anywhere') || require('run-anywhere');
const awsServiceLib           = require('../../lib/service/service');

const argvGet                 = sg.argvGet;
const argvExtract             = sg.argvExtract;

var lib = {};

lib.listObjects = lib.list = lib.ls = function() {
  var   u               = sg.prepUsage();

  return raLib.adapt(arguments, (argv, context, callback) => {
    const eachAwsService    = ra.wrap(awsServiceLib.eachSwsService);

    // TODO: add acct/onlyOneAcct
    const Bucket        = argvExtract(argv, u('bucket,Bucket,bucket-name',  '=abc', 'The bucket name.'));
    const Key           = argvExtract(argv, u('key,Key',                    '=abc', 'The key.'));

    //if (!xyz)           { return u.sage('xyz', 'Need XYZ.', callback); }

    return sg.__run2({}, callback, [function(result, next, last, abort) {

      return eachAwsService('S3', next, {}, (s3, callback) => {
        // TODO: build s3params, and call s3.listObjectsV2();
        return callback();
      });

    }], function abort(err, msg) {
      if (msg)  { return sg.die(err, callback, msg); }
      return callback(err);
    });
  });
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

